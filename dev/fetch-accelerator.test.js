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

async function testPostRequestBodyPassesThrough() {
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) { return new Response(await request.text()); },
    config: baseConfig()
  });
  var request = new Request("https://www.douyin.com/example", {
    method: "POST", body: "payload"
  });
  var response = await accelerator.fetch(request);
  assert.equal(await response.text(), "payload");
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

    if (request.headers.has("if-range")) {
      return new Response(fixtureMedia, { status: 200 });
    }

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
  var conditional = await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=164-363", "If-Range": '"old-version"' }
  }));
  assert.equal(conditional.status, 200, "conditional ranges must retain native response semantics");
  beforeSecondDemand = calls.length;
  var aborted = new AbortController();
  aborted.abort();
  await assert.rejects(accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=164-363" }, signal: aborted.signal
  })), { name: "AbortError" });
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

async function testAbortWhileJoiningPrefetch() {
  var fixture = makeFixture({ delayMs: 5 });
  var started;
  var prefetchStarted = new Promise(function (resolve) { started = resolve; });
  var release;
  var gate = new Promise(function (resolve) { release = resolve; });
  var nextStart;
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) {
      var range = core.parseRangeHeader(request.headers.get("range"));
      if (range.start === nextStart) {
        started();
        await gate;
      }
      return fixture.fetch(request);
    },
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0, prefetchWaitMs: 1000 })
  });
  var url = "https://v3-web-prime.douyinvod.com/video/abort-join";
  var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
  var first = index.segments[0];
  var second = index.segments[1];
  nextStart = second.start;
  await (await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + first.start + "-" + first.end }
  }))).arrayBuffer();
  await prefetchStarted;
  var controller = new AbortController();
  var demand = accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + second.start + "-" + second.end }, signal: controller.signal
  }));
  controller.abort();
  await assert.rejects(demand, { name: "AbortError" });
  release();
  await delay(30);
  var callsBeforeHit = fixture.calls.length;
  var hit = await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + second.start + "-" + second.end }
  }));
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), media.slice(second.start, second.end + 1));
  assert.equal(fixture.calls.length, callsBeforeHit, "aborting the consumer must not cancel shared prefetch");
}

async function testPrefetchDoesNotCrossUrlVariants() {
  var calls = [];
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) {
      var range = core.parseRangeHeader(request.headers.get("range"));
      var variant = new URL(request.url).searchParams.get("variant");
      calls.push(variant);
      return new Response(new Uint8Array(range.length).fill(variant === "a" ? 1 : 2), {
        status: 206, headers: { "content-range": "bytes " + range.start + "-" + range.end + "/10000" }
      });
    },
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0 })
  });
  var url = "https://v3-web-prime.douyinvod.com/shared-path?variant=";
  var index = accelerator.observeMediaIndex(url + "a", "bytes=0-63", new Uint8Array(makeSidx()));
  var first = index.segments[0];
  var second = index.segments[1];
  await (await accelerator.fetch(new Request(url + "a", {
    headers: { Range: "bytes=" + first.start + "-" + first.end }
  }))).arrayBuffer();
  await delay(30);
  var response = await accelerator.fetch(new Request(url + "b", {
    headers: { Range: "bytes=" + second.start + "-" + second.end }
  }));
  assert.ok(new Uint8Array(await response.arrayBuffer()).every(function (value) { return value === 2; }),
    "different URL variants must not share prefetched bytes");
  assert.ok(calls.includes("b"));
}

async function testPrefetchDoesNotCrossRequestHeaders() {
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) {
      var range = core.parseRangeHeader(request.headers.get("range"));
      var variant = request.headers.get("x-variant");
      return new Response(new Uint8Array(range.length).fill(variant === "a" ? 1 : 2), {
        status: 206, headers: { "content-range": "bytes " + range.start + "-" + range.end + "/10000" }
      });
    },
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0 })
  });
  var url = "https://v3-web-prime.douyinvod.com/video/header-variant";
  var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
  var first = index.segments[0];
  var second = index.segments[1];
  await (await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + first.start + "-" + first.end, "X-Variant": "a" }
  }))).arrayBuffer();
  await delay(30);
  var response = await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + second.start + "-" + second.end, "X-Variant": "b" }
  }));
  assert.ok(new Uint8Array(await response.arrayBuffer()).every(function (value) { return value === 2; }),
    "requests with different headers must not share prefetched bytes");
}

async function testNoStoreRequestSkipsPrefetchCache() {
  var fixture = makeFixture({ delayMs: 5 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0 })
  });
  var url = "https://v3-web-prime.douyinvod.com/video/no-store";
  var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
  var first = index.segments[0];
  var second = index.segments[1];
  await (await accelerator.fetch(new Request(url, {
    cache: "no-store", headers: { Range: "bytes=" + first.start + "-" + first.end }
  }))).arrayBuffer();
  await delay(30);
  await (await accelerator.fetch(new Request(url, {
    cache: "no-store", headers: { Range: "bytes=" + second.start + "-" + second.end }
  }))).arrayBuffer();
  assert.equal(accelerator.getStats().prefetchHits, 0, "no-store must not consume extension cache");
  assert.equal(fixture.calls.length, 2, "no-store must not prefetch extra requests");
}

async function testClearCachesRejectsLatePrefetchResult() {
  var release;
  var gate = new Promise(function (resolve) { release = resolve; });
  var started;
  var prefetchStarted = new Promise(function (resolve) { started = resolve; });
  var nextStart;
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) {
      var range = core.parseRangeHeader(request.headers.get("range"));
      if (range.start === nextStart) { started(); await gate; }
      return new Response(media.slice(range.start, range.end + 1), {
        status: 206, headers: { "content-range": "bytes " + range.start + "-" + range.end + "/" + media.length }
      });
    },
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0 })
  });
  var url = "https://v3-web-prime.douyinvod.com/video/clear-cache";
  var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
  nextStart = index.segments[1].start;
  var first = index.segments[0];
  await (await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + first.start + "-" + first.end }
  }))).arrayBuffer();
  await prefetchStarted;
  accelerator.clearCaches();
  release();
  await delay(30);
  assert.equal(accelerator.getStats().prefetch.cacheEntries, 0, "cleared cache must reject late results");
}

async function testDisableCancelsScheduledPrefetch() {
  var fixture = makeFixture({ delayMs: 5 });
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: fixture.fetch,
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 100 })
  });
  var url = "https://v3-web-prime.douyinvod.com/video/disable-prefetch";
  var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
  var first = index.segments[0];
  await (await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + first.start + "-" + first.end }
  }))).arrayBuffer();
  accelerator.updateConfig({ prefetchEnabled: false });
  await delay(150);
  assert.equal(fixture.calls.length, 1, "disabled prefetch must not start delayed work");
}

async function testPrefetchRespectsGlobalConcurrency() {
  var active = 0;
  var peak = 0;
  var release;
  var gate = new Promise(function (resolve) { release = resolve; });
  var nextStart;
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) {
      var range = core.parseRangeHeader(request.headers.get("range"));
      if (range.start === nextStart) {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
      }
      return new Response(media.slice(range.start, range.end + 1), {
        status: 206, headers: { "content-range": "bytes " + range.start + "-" + range.end + "/" + media.length }
      });
    },
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0, globalConcurrency: 1 })
  });
  var urls = ["https://v3-web-prime.douyinvod.com/video/concurrency-a", "https://v3-web-prime.douyinvod.com/video/concurrency-b"];
  var index = accelerator.observeMediaIndex(urls[0], "bytes=0-63", new Uint8Array(makeSidx()));
  accelerator.observeMediaIndex(urls[1], "bytes=0-63", new Uint8Array(makeSidx()));
  nextStart = index.segments[1].start;
  var first = index.segments[0];
  for (var url of urls) {
    await (await accelerator.fetch(new Request(url, {
      headers: { Range: "bytes=" + first.start + "-" + first.end }
    }))).arrayBuffer();
  }
  await delay(30);
  release();
  await delay(30);
  assert.equal(peak, 1, "prefetches must share the global concurrency limit");
}

async function testPrefetchTimesOut() {
  var nextStart;
  var aborted = false;
  var accelerator = acceleratorApi.createFetchAccelerator({
    nativeFetch: async function (request) {
      var range = core.parseRangeHeader(request.headers.get("range"));
      if (range.start === nextStart) {
        await new Promise(function (resolve, reject) {
          request.signal.addEventListener("abort", function () {
            aborted = true;
            reject(request.signal.reason);
          }, { once: true });
        });
      }
      return new Response(media.slice(range.start, range.end + 1), {
        status: 206, headers: { "content-range": "bytes " + range.start + "-" + range.end + "/" + media.length }
      });
    },
    config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0, timeoutMs: 1000 })
  });
  var url = "https://v3-web-prime.douyinvod.com/video/prefetch-timeout";
  var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
  nextStart = index.segments[1].start;
  var first = index.segments[0];
  await (await accelerator.fetch(new Request(url, {
    headers: { Range: "bytes=" + first.start + "-" + first.end }
  }))).arrayBuffer();
  await delay(1200);
  assert.equal(aborted, true, "stalled prefetch should be aborted by timeout");
  assert.equal(accelerator.getStats().prefetch.inflight, 0);
  assert.equal(accelerator.getStats().semaphore.active, 0);
}

async function testUnsafePrefetchResponsesAreNotCached() {
  for (var kind of ["encoding", "unknown-total", "response-no-store"]) {
    var nextStart;
    var nextCalls = 0;
    var accelerator = acceleratorApi.createFetchAccelerator({
      nativeFetch: async function (request) {
        var range = core.parseRangeHeader(request.headers.get("range"));
        if (range.start === nextStart) nextCalls += 1;
        var headers = { "content-range": "bytes " + range.start + "-" + range.end + "/" +
          (range.start === nextStart && kind === "unknown-total" ? "*" : media.length) };
        if (range.start === nextStart && kind === "encoding") headers["content-encoding"] = "gzip";
        if (range.start === nextStart && kind === "response-no-store") headers["cache-control"] = "no-store";
        return new Response(media.slice(range.start, range.end + 1), { status: 206, headers: headers });
      },
      config: baseConfig({ prefetchEnabled: true, prefetchDelayMs: 0 })
    });
    var url = "https://v3-web-prime.douyinvod.com/video/unsafe-" + kind;
    var index = accelerator.observeMediaIndex(url, "bytes=0-63", new Uint8Array(makeSidx()));
    var first = index.segments[0];
    var second = index.segments[1];
    nextStart = second.start;
    await (await accelerator.fetch(new Request(url, {
      headers: { Range: "bytes=" + first.start + "-" + first.end }
    }))).arrayBuffer();
    await delay(30);
    var response = await accelerator.fetch(new Request(url, {
      headers: { Range: "bytes=" + second.start + "-" + second.end }
    }));
    await response.arrayBuffer();
    assert.equal(nextCalls, 2, kind + " must fall back to a native demand request");
    if (kind === "unknown-total") assert.ok(response.headers.get("content-range").endsWith("/*"));
  }
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

async function testZjcdnMediaAndUnrelatedTraffic() {
  var fixture = makeFixture();
  var accelerator = acceleratorApi.createFetchAccelerator({ nativeFetch: fixture.fetch, config: baseConfig() });
  var prefix = "https://v5-dy-ov-experiment.zjcdn.com/abc/def/video/tos/cn/tos-cn-ve-15c000-ce/id/";
  var response = await accelerator.fetch(new Request(prefix + "media-video-hvc1/?a=6383", { headers: { Range: "bytes=0-799999" } }));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), media.slice(0, 800000));
  assert.equal(accelerator.getStats().accelerated, 1);
  assert.equal(fixture.calls.length, 3);
  await (await accelerator.fetch(new Request("https://v5-dy-ov-experiment.zjcdn.com/unrelated", { headers: { Range: "bytes=0-799999" } }))).arrayBuffer();
  assert.equal(fixture.calls.length, 4);
  assert.equal(accelerator.getStats().accelerated, 1);
  var failing = makeFixture({ failSubranges: true, originalLength: 800000 });
  var fallback = acceleratorApi.createFetchAccelerator({ nativeFetch: failing.fetch, config: baseConfig() });
  var recovered = await fallback.fetch(new Request(prefix + "media-video-hvc1/?a=6383", { headers: { Range: "bytes=0-799999" } }));
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), media.slice(0, 800000));
  assert.equal(fallback.getStats().fallbacks, 1);
  assert.ok(failing.calls.some(function (call) { return call.range.length === 800000; }));
}

(async function () {
  await testZjcdnMediaAndUnrelatedTraffic();
  await testAcceleratedRange();
  await testPostRequestBodyPassesThrough();
  await testSmallRangeBypasses();
  await testFailureFallsBackToOriginalRange();
  await testSiblingSubrangesAbortBeforeFallback();
  await testAbortDoesNotFallback();
  await testSidxNextSegmentPrefetchServesCache();
  await testObservedMediaIndexStartsPrefetch();
  await testAbortWhileJoiningPrefetch();
  await testPrefetchDoesNotCrossUrlVariants();
  await testPrefetchDoesNotCrossRequestHeaders();
  await testNoStoreRequestSkipsPrefetchCache();
  await testClearCachesRejectsLatePrefetchResult();
  await testDisableCancelsScheduledPrefetch();
  await testPrefetchRespectsGlobalConcurrency();
  await testPrefetchTimesOut();
  await testUnsafePrefetchResponsesAreNotCached();
  await testAdaptiveFastHostReturnsToNative();
  await testAdaptiveSlowHostUsesTwoWayForMidSizedVideoRange();
  await testAdaptiveFastHostKeepsMidSizedVideoRangeNative();
  await testAdaptiveSlowHostUsesThreeWay();
  console.log("fetch-accelerator.test.js: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
