"use strict";

var assert = require("node:assert/strict");
var core = require("../src/range-core.js");
var acceleratorApi = require("../src/fetch-accelerator.js");

var media = new Uint8Array(2 * 1024 * 1024);
for (var i = 0; i < media.length; i += 1) {
  media[i] = i % 251;
}

function makeBox(type, payload) {
  var out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
}

function makeSidx() {
  var payload = Buffer.alloc(48);
  var p = 0;

  payload.writeUInt8(0, p);
  payload.writeUIntBE(0, p + 1, 3);
  p += 4;
  payload.writeUInt32BE(1, p); p += 4;
  payload.writeUInt32BE(1000, p); p += 4;
  payload.writeUInt32BE(0, p); p += 4;
  payload.writeUInt32BE(0, p); p += 4;
  payload.writeUInt16BE(0, p); p += 2;
  payload.writeUInt16BE(2, p); p += 2;

  payload.writeUInt32BE(100, p); p += 4;
  payload.writeUInt32BE(5000, p); p += 4;
  payload.writeUInt32BE(0x90000000, p); p += 4;

  payload.writeUInt32BE(200, p); p += 4;
  payload.writeUInt32BE(3000, p); p += 4;
  payload.writeUInt32BE(0x90000000, p); p += 4;

  return Buffer.concat([
    makeBox("ftyp", Buffer.alloc(0)),
    makeBox("sidx", payload)
  ]);
}

function delay(ms, signal) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", function () {
        clearTimeout(timer);
        var error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }
  });
}

function makeFixture(options) {
  var opts = options || {};
  var calls = [];
  var active = 0;
  var maxActive = 0;
  var abortedCount = 0;

  async function fetchFixture(input, init) {
    var request = input instanceof Request ? input : new Request(input, init);
    var range = core.parseRangeHeader(request.headers.get("range"));

    calls.push({
      url: request.url,
      range: range
    });

    active += 1;
    maxActive = Math.max(maxActive, active);

    try {
      var waitMs = opts.delayMs || 8;
      if (
        range &&
        opts.failFastStart !== undefined &&
        range.start === opts.failFastStart &&
        range.length < opts.originalLength
      ) {
        waitMs = 5;
      }

      try {
        await delay(waitMs, request.signal);
      } catch (error) {
        if (error && error.name === "AbortError") {
          abortedCount += 1;
        }
        throw error;
      }

      if (!range) {
        return new Response(media, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(media.length)
          }
        });
      }

      if (opts.failSubranges && range.length < opts.originalLength) {
        return new Response("temporary", { status: 503 });
      }

      var bytes = media.slice(range.start, range.end + 1);
      return new Response(bytes, {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "accept-ranges": "bytes",
          "content-type": "video/mp4",
          "content-length": String(bytes.byteLength),
          "content-range":
            "bytes " +
            String(range.start) +
            "-" +
            String(range.end) +
            "/" +
            String(media.length),
          "etag": "fixture-etag"
        }
      });
    } finally {
      active -= 1;
    }
  }

  return {
    fetch: fetchFixture,
    calls: calls,
    maxActive: function () { return maxActive; },
    abortedCount: function () { return abortedCount; }
  };
}

function baseConfig(extra) {
  return Object.assign({
    adaptiveConcurrency: false,
    multiCdnEnabled: false,
    prefetchEnabled: false,
    minSplitBytes: 256 * 1024,
    targetChunkBytes: 192 * 1024,
    maxPieces: 3,
    globalConcurrency: 3,
    timeoutMs: 2000,
    maxRetries: 0
  }, extra || {});
}

async function testAcceleratedRange() {
  var fixture = makeFixture({ delayMs: 15 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig()
  });

  var start = 100000;
  var end = 899999;
  var response = await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test/media-video-hvc1/?fid=x&webid=y",
    { headers: { Range: "bytes=" + String(start) + "-" + String(end) } }
  ));

  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get("content-range"),
    "bytes " + String(start) + "-" + String(end) + "/" + String(media.length)
  );

  var actual = new Uint8Array(await response.arrayBuffer());
  var expected = media.slice(start, end + 1);
  assert.deepEqual(actual, expected);
  assert.equal(fixture.calls.length, 3);
  assert.ok(fixture.maxActive() <= 3);

  var stats = accelerator.getStats();
  assert.equal(stats.accelerated, 1);
  assert.equal(stats.fallbacks, 0);
  assert.equal(stats.subrequests, 3);
  assert.equal(stats.bytesAccelerated, end - start + 1);
}

async function testSmallRangeBypasses() {
  var fixture = makeFixture();
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig()
  });

  var response = await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test",
    { headers: { Range: "bytes=0-65535" } }
  ));

  assert.equal(response.status, 206);
  assert.equal(fixture.calls.length, 1);
  assert.equal(accelerator.getStats().bypassedSmall, 1);
}

async function testFailureFallsBackToOriginalRange() {
  var start = 200000;
  var end = 899999;
  var originalLength = end - start + 1;
  var fixture = makeFixture({
    failSubranges: true,
    originalLength: originalLength
  });

  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig()
  });

  var response = await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test",
    { headers: { Range: "bytes=" + String(start) + "-" + String(end) } }
  ));

  assert.equal(response.status, 206);
  var bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(bytes, media.slice(start, end + 1));

  var originalCalls = fixture.calls.filter(function (call) {
    return call.range && call.range.length === originalLength;
  });
  assert.equal(originalCalls.length, 1);
  assert.equal(accelerator.getStats().fallbacks, 1);
}

async function testSiblingSubrangesAbortBeforeFallback() {
  var start = 300000;
  var end = 999999;
  var originalLength = end - start + 1;
  var fixture = makeFixture({
    failSubranges: true,
    originalLength: originalLength,
    failFastStart: start,
    delayMs: 120
  });

  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig()
  });

  var response = await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test",
    { headers: { Range: "bytes=" + String(start) + "-" + String(end) } }
  ));

  assert.equal(response.status, 206);
  assert.ok(fixture.abortedCount() >= 1);
  assert.equal(accelerator.getStats().fallbacks, 1);
}

async function testAbortDoesNotFallback() {
  var fixture = makeFixture({ delayMs: 100 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({ globalConcurrency: 2 })
  });

  var controller = new AbortController();
  var request = new Request(
    "https://v3-web-prime.douyinvod.com/video/test",
    {
      headers: { Range: "bytes=0-699999" },
      signal: controller.signal
    }
  );

  var promise = accelerator.fetch(request);
  setTimeout(function () { controller.abort(); }, 15);

  await assert.rejects(promise, function (error) {
    return error && error.name === "AbortError";
  });

  var stats = accelerator.getStats();
  assert.equal(stats.fallbacks, 0);
  assert.equal(stats.failures, 1);
  assert.equal(
    stats.resolver.hosts["v3-web-prime.douyinvod.com"].failures,
    0
  );
}

function makeBox(type, payload) {
  var out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
}

function makePrefetchMedia() {
  var payload = Buffer.alloc(48);
  var p = 0;

  payload.writeUInt8(0, p);
  payload.writeUIntBE(0, p + 1, 3);
  p += 4;
  payload.writeUInt32BE(7, p); p += 4;
  payload.writeUInt32BE(1000, p); p += 4;
  payload.writeUInt32BE(0, p); p += 4;
  payload.writeUInt32BE(0, p); p += 4;
  payload.writeUInt16BE(0, p); p += 2;
  payload.writeUInt16BE(2, p); p += 2;

  payload.writeUInt32BE(100, p); p += 4;
  payload.writeUInt32BE(5000, p); p += 4;
  payload.writeUInt32BE(0x90000000, p); p += 4;

  payload.writeUInt32BE(200, p); p += 4;
  payload.writeUInt32BE(3000, p); p += 4;
  payload.writeUInt32BE(0x90000000, p); p += 4;

  var index = Buffer.concat([
    makeBox("ftyp", Buffer.alloc(0)),
    makeBox("sidx", payload)
  ]);
  var segment1 = Buffer.alloc(100, 17);
  var segment2 = Buffer.alloc(200, 29);
  return new Uint8Array(Buffer.concat([index, segment1, segment2]));
}

async function testSidxNextSegmentPrefetchServesCache() {
  var fixtureMedia = makePrefetchMedia();
  var calls = [];

  async function fixtureFetch(input, init) {
    var request = input instanceof Request ? input : new Request(input, init);
    var range = core.parseRangeHeader(request.headers.get("range"));
    assert.ok(range);

    calls.push({
      start: range.start,
      end: range.end
    });

    await delay(5, request.signal);

    var bytes = fixtureMedia.slice(range.start, range.end + 1);
    return new Response(bytes, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "accept-ranges": "bytes",
        "content-type": "video/mp4",
        "content-length": String(bytes.byteLength),
        "content-range":
          "bytes " +
          String(range.start) +
          "-" +
          String(range.end) +
          "/" +
          String(fixtureMedia.byteLength)
      }
    });
  }

  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixtureFetch,
    config: baseConfig({
      prefetchEnabled: true,
      prefetchSegments: 1,
      prefetchDelayMs: 0,
      prefetchWaitMs: 200,
      prefetchCacheBytes: 2 * 1024 * 1024,
      minSplitBytes: 512 * 1024
    })
  });

  var url = "https://v3-web-prime.douyinvod.com/video/prefetch/media-video-hvc1/?fid=x&webid=y";

  var indexResponse = await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=0-63" }
  }));
  await indexResponse.arrayBuffer();
  await delay(25);

  var firstResponse = await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=64-163" }
  }));
  assert.deepEqual(
    new Uint8Array(await firstResponse.arrayBuffer()),
    fixtureMedia.slice(64, 164)
  );

  await delay(40);

  assert.equal(
    calls.filter(function (call) {
      return call.start === 164 && call.end === 363;
    }).length,
    1
  );

  var beforeSecondDemand = calls.length;
  var secondResponse = await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=164-363" }
  }));

  assert.deepEqual(
    new Uint8Array(await secondResponse.arrayBuffer()),
    fixtureMedia.slice(164, 364)
  );
  assert.equal(calls.length, beforeSecondDemand);

  var stats = accelerator.getStats();
  assert.ok(stats.prefetchHits >= 1);
  assert.equal(stats.prefetchBytesServed, 200);
  assert.ok(stats.prefetch.stats.indexesParsed >= 1);
  assert.ok(stats.prefetch.stats.scheduled >= 1);
  assert.ok(stats.prefetch.stats.completed >= 1);
}

async function testObservedMediaIndexStartsPrefetch() {
  var fixture = makeFixture({ delayMs: 5 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({
      prefetchEnabled: true,
      prefetchSegments: 1,
      prefetchDelayMs: 0,
      prefetchWaitMs: 100,
      minSplitBytes: 512 * 1024
    })
  });

  var url =
    "https://v3-web-prime.douyinvod.com/video/test-index/media-video-hvc1/?fid=x&webid=y";

  var parsed = accelerator.observeMediaIndex(
    url,
    "bytes=0-63",
    new Uint8Array(makeSidx())
  );

  assert.ok(parsed);
  assert.equal(accelerator.getStats().mediaIndexesObserved, 1);
  assert.equal(accelerator.getStats().prefetch.stats.indexesParsed, 1);

  var first = parsed.segments[0];
  var second = parsed.segments[1];

  await (await accelerator.fetch(new Request(
    url,
    { headers: { Range: "bytes=" + first.start + "-" + first.end } }
  ))).arrayBuffer();

  await delay(30);

  var afterPrefetch = accelerator.getStats();
  assert.ok(afterPrefetch.prefetch.stats.scheduled >= 1);
  assert.ok(afterPrefetch.prefetch.stats.completed >= 1);

  var callsBeforeHit = fixture.calls.length;
  var hit = await accelerator.fetch(new Request(
    url,
    { headers: { Range: "bytes=" + second.start + "-" + second.end } }
  ));
  await hit.arrayBuffer();

  assert.equal(fixture.calls.length, callsBeforeHit);
  assert.ok(accelerator.getStats().prefetchHits >= 1);
}

async function testAdaptiveFastHostReturnsToNative() {
  var fixture = makeFixture({ delayMs: 5 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({
      adaptiveConcurrency: true,
      minSplitBytes: 512 * 1024,
      maxPieces: 3,
      fastTtfbMs: 60,
      threeWayTtfbMs: 180
    })
  });

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-fast",
    { headers: { Range: "bytes=0-699999" } }
  ))).arrayBuffer();

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-fast",
    { headers: { Range: "bytes=700000-1399999" } }
  ))).arrayBuffer();

  var stats = accelerator.getStats();
  assert.ok(stats.adaptive2Way >= 1);
  assert.ok(stats.adaptiveNative >= 1);
}

async function testAdaptiveSlowHostUsesTwoWayForMidSizedVideoRange() {
  var fixture = makeFixture({ delayMs: 220 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({
      adaptiveConcurrency: true,
      minSplitBytes: 512 * 1024,
      slowMinSplitBytes: 320 * 1024,
      maxPieces: 3,
      fastTtfbMs: 60,
      threeWayTtfbMs: 180
    })
  });

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-mid-slow",
    { headers: { Range: "bytes=0-65535" } }
  ))).arrayBuffer();

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-mid-slow",
    { headers: { Range: "bytes=65536-131071" } }
  ))).arrayBuffer();

  var before = fixture.calls.length;

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-mid-slow",
    { headers: { Range: "bytes=200000-599999" } }
  ))).arrayBuffer();

  var after = fixture.calls.length;
  var stats = accelerator.getStats();

  assert.equal(after - before, 2);
  assert.ok(stats.adaptive2Way >= 1);
}

async function testAdaptiveFastHostKeepsMidSizedVideoRangeNative() {
  var fixture = makeFixture({ delayMs: 5 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({
      adaptiveConcurrency: true,
      minSplitBytes: 512 * 1024,
      slowMinSplitBytes: 320 * 1024,
      maxPieces: 3,
      fastTtfbMs: 60,
      threeWayTtfbMs: 180
    })
  });

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-mid-fast",
    { headers: { Range: "bytes=0-65535" } }
  ))).arrayBuffer();

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-mid-fast",
    { headers: { Range: "bytes=65536-131071" } }
  ))).arrayBuffer();

  var before = fixture.calls.length;

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-mid-fast",
    { headers: { Range: "bytes=200000-599999" } }
  ))).arrayBuffer();

  var after = fixture.calls.length;
  var stats = accelerator.getStats();

  assert.equal(after - before, 1);
  assert.ok(stats.adaptiveNative >= 3);
}

async function testAdaptiveSlowHostUsesThreeWay() {
  var fixture = makeFixture({ delayMs: 220 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({
      adaptiveConcurrency: true,
      minSplitBytes: 512 * 1024,
      maxPieces: 3,
      fastTtfbMs: 60,
      threeWayTtfbMs: 180
    })
  });

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-slow",
    { headers: { Range: "bytes=0-699999" } }
  ))).arrayBuffer();

  await (await accelerator.fetch(new Request(
    "https://v3-web-prime.douyinvod.com/video/test-slow",
    { headers: { Range: "bytes=700000-1399999" } }
  ))).arrayBuffer();

  var stats = accelerator.getStats();
  assert.ok(stats.adaptive2Way >= 1);
  assert.ok(stats.adaptive3Way >= 1);
}

(async function () {
  await testAcceleratedRange();
  await testSmallRangeBypasses();
  await testFailureFallsBackToOriginalRange();
  await testSiblingSubrangesAbortBeforeFallback();
  await testAbortDoesNotFallback();
  await testSidxNextSegmentPrefetchServesCache();
  await testObservedMediaIndexStartsPrefetch();
  await testAdaptiveFastHostReturnsToNative();
  await testAdaptiveSlowHostUsesTwoWayForMidSizedVideoRange();
  await testAdaptiveFastHostKeepsMidSizedVideoRangeNative();
  await testAdaptiveSlowHostUsesThreeWay();
  console.log("fetch-accelerator.test.js: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
