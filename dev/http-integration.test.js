"use strict";

// Exercise the accelerator over real loopback HTTP, without external services.
var assert = require("node:assert/strict");
var http = require("node:http");
var core = require("../src/range-core.js");
var acceleratorApi = require("../src/fetch-accelerator.js");

var media = Buffer.alloc(800000);
for (var i = 0; i < media.length; i += 1) media[i] = i % 251;
var active = 0;
var peak = 0;
var requests = [];
var retryRanges = new Set();
var abortConnections = 0;
var abortClosed = 0;
var allAbortStarted;
var allAbortClosed;
var abortStarted = new Promise(function (resolve) { allAbortStarted = resolve; });
var abortDone = new Promise(function (resolve) { allAbortClosed = resolve; });
var server = http.createServer(function (req, res) {
  var range = core.parseRangeHeader(req.headers.range);
  if (!range || range.end >= media.length) {
    res.writeHead(416).end();
    return;
  }
  requests.push({ path: req.url, start: range.start, end: range.end });
  active += 1;
  peak = Math.max(peak, active);
  var counted = true;
  res.on("close", function () { if (counted) { active -= 1; counted = false; } });
  if (req.url === "/abort") {
    abortConnections += 1;
    if (abortConnections === 3) allAbortStarted();
    res.on("close", function () {
      abortClosed += 1;
      if (abortClosed === 3) allAbortClosed();
    });
    return;
  }
  setTimeout(function () {
    if (res.destroyed) return;
    if (req.url === "/broken" && range.length < media.length && range.start !== 0) {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/retry" && !retryRanges.has(req.headers.range)) {
      retryRanges.add(req.headers.range);
      res.writeHead(503).end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": "bytes " + range.start + "-" + range.end + "/" + media.length,
      "Content-Length": String(range.length),
      "Content-Type": "video/mp4",
      "ETag": '"fixture"'
    });
    var middle = range.start + Math.floor(range.length / 2);
    res.write(media.subarray(range.start, middle));
    setTimeout(function () { if (!res.destroyed) res.end(media.subarray(middle, range.end + 1)); }, 5);
  }, 20);
});

(async function () {
  await new Promise(function (resolve, reject) {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    var port = server.address().port;
    var accelerator = acceleratorApi.createFetchAccelerator({
      nativeFetch: function (request) {
        var target = new URL(request.url);
        return fetch(new Request("http://127.0.0.1:" + port + target.pathname, request));
      },
      config: {
        adaptiveConcurrency: false, multiCdnEnabled: false, prefetchEnabled: false,
        minSplitBytes: 256 * 1024, targetChunkBytes: 256 * 1024, maxPieces: 3,
        globalConcurrency: 3, maxRetries: 0
      }
    });
    async function get(path) {
      var response = await accelerator.fetch(new Request("https://fixture.douyinvod.com" + path, {
        headers: { Range: "bytes=0-799999" }
      }));
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), "bytes 0-799999/800000");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), media);
    }
    await get("/normal");
    assert.equal(requests.filter(function (r) { return r.path === "/normal"; }).length, 3);
    assert.ok(peak > 1, "subrequests must overlap on the server");
    await get("/broken");
    assert.ok(requests.some(function (r) { return r.path === "/broken" && r.start === 0 && r.end === 799999; }),
      "failure must issue the original range over HTTP");
    assert.equal(accelerator.getStats().fallbacks, 1);
    var controller = new AbortController();
    var cancelled = accelerator.fetch(new Request("https://fixture.douyinvod.com/abort", {
      headers: { Range: "bytes=0-799999" }, signal: controller.signal
    }));
    await Promise.race([abortStarted, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("subrequests did not start")); }, 2000).unref();
    })]);
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    await Promise.race([abortDone, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("subrequests were not cancelled")); }, 2000).unref();
    })]);
    assert.equal(requests.filter(function (r) { return r.path === "/abort"; }).length, 3,
      "cancellation must not retry the original range");
    assert.equal(accelerator.getStats().fallbacks, 1, "abort must not count as fallback");
    accelerator.updateConfig({ maxRetries: 1 });
    await get("/retry");
    assert.equal(requests.filter(function (r) { return r.path === "/retry"; }).length, 6,
      "each of the three failed ranges should be retried once");
    assert.equal(accelerator.getStats().retries, 3);
    assert.equal(accelerator.getStats().fallbacks, 1, "successful retry must not cause fallback");
    console.log("http-integration.test.js: ok");
  } finally {
    server.closeAllConnections();
    await new Promise(function (resolve) { server.close(resolve); });
  }
})().catch(function (error) { console.error(error); process.exitCode = 1; });
