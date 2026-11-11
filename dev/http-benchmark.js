"use strict";

// Controlled loopback comparison: each response is independently rate limited.
// Results are not representative of a real CDN or a shared bottleneck.
var assert = require("node:assert/strict");
var http = require("node:http");
var core = require("../src/range-core.js");
var acceleratorApi = require("../src/fetch-accelerator.js");
var media = Buffer.alloc(800000);
for (var i = 0; i < media.length; i += 1) media[i] = i % 251;

var server = http.createServer(function (request, response) {
  var range = core.parseRangeHeader(request.headers.range);
  if (!range || range.end >= media.length) { response.writeHead(416).end(); return; }
  response.writeHead(206, {
    "Content-Range": "bytes " + range.start + "-" + range.end + "/" + media.length,
    "Content-Length": range.length,
    "ETag": '"fixture"'
  });
  var offset = range.start;
  var timer = setInterval(function () {
    var end = Math.min(offset + 32768, range.end + 1);
    response.write(media.subarray(offset, end));
    offset = end;
    if (offset > range.end) { clearInterval(timer); response.end(); }
  }, 10);
  response.once("close", function () { clearInterval(timer); });
});

function median(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

(async function () {
  await new Promise(function (resolve, reject) { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    var port = server.address().port;
    function nativeFetch(request) {
      return fetch(new Request("http://127.0.0.1:" + port + "/media", request));
    }
    var accelerator = acceleratorApi.createFetchAccelerator({
      nativeFetch: nativeFetch,
      config: { adaptiveConcurrency: false, multiCdnEnabled: false, prefetchEnabled: false,
        minSplitBytes: 256 * 1024, targetChunkBytes: 256 * 1024, maxPieces: 3, maxRetries: 0 }
    });
    async function measure(accelerated) {
      var request = new Request("https://fixture.douyinvod.com/media", { headers: { Range: "bytes=0-799999" } });
      var started = performance.now();
      var response = accelerated ? await accelerator.fetch(request) : await nativeFetch(request);
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), media);
      return performance.now() - started;
    }
    await measure(false);
    await measure(true);
    var nativeTimes = [];
    var acceleratedTimes = [];
    for (var run = 0; run < 6; run += 1) {
      if (run % 2) {
        acceleratedTimes.push(await measure(true));
        nativeTimes.push(await measure(false));
      } else {
        nativeTimes.push(await measure(false));
        acceleratedTimes.push(await measure(true));
      }
    }
    var nativeMedian = median(nativeTimes);
    var acceleratedMedian = median(acceleratedTimes);
    console.log(JSON.stringify({ environment: "loopback; per-response 32768 bytes per 10 ms", pairs: 6,
      nativeMedianMs: Math.round(nativeMedian), acceleratedMedianMs: Math.round(acceleratedMedian),
      reductionPercent: Math.round((1 - acceleratedMedian / nativeMedian) * 100),
      acceleratedRequests: accelerator.getStats().accelerated, fallbacks: accelerator.getStats().fallbacks }));
  } finally {
    server.closeAllConnections();
    await new Promise(function (resolve) { server.close(resolve); });
  }
})().catch(function (error) { console.error(error); process.exitCode = 1; });
