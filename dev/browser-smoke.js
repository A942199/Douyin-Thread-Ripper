"use strict";

// Run explicitly with Node and a Chromium executable; uses a disposable profile.
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var childProcess = require("node:child_process");

var packageDir = null;
var root = path.resolve(__dirname, "..");
if (process.argv.includes("--package")) {
  packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtr-package-test-"));
  var archive = path.join(root, "dist", "Douyin-Thread-Ripper-v0.2.7.zip");
  var extraction = childProcess.spawnSync("tar", ["-xf", archive, "-C", packageDir], { encoding: "utf8" });
  if (extraction.error || extraction.status !== 0) {
    fs.rmSync(packageDir, { recursive: true, force: true });
    throw extraction.error || new Error("Archive extraction failed: " + extraction.stderr);
  }
  root = packageDir;
}
var browser = process.env.DTR_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
var profile = fs.mkdtempSync(path.join(os.tmpdir(), "dtr-browser-test-"));
var child = childProcess.spawn(browser, [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--edge-skip-compat-layer-relaunch",
  "--user-data-dir=" + profile, "--remote-debugging-port=0",
  "--disable-extensions-except=" + root, "--load-extension=" + root,
  "about:blank"
], { stdio: "ignore" });

function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function connect(url) {
  var socket = new WebSocket(url);
  await new Promise(function (resolve, reject) {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  var nextId = 0;
  var pending = new Map();
  var listeners = [];
  socket.addEventListener("message", function (event) {
    var message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      var callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    } else if (message.method) {
      listeners.forEach(function (listener) { listener(message); });
    }
  });
  return {
    send: function (method, params, sessionId) {
      var id = ++nextId;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        socket.send(JSON.stringify({ id: id, method: method, params: params || {}, sessionId: sessionId }));
      });
    },
    onEvent: function (listener) { listeners.push(listener); },
    close: function () { socket.close(); }
  };
}

async function waitFor(fn, description, timeout) {
  var deadline = Date.now() + (timeout || 15000);
  while (Date.now() < deadline) {
    var result = await fn();
    if (result) return result;
    if (child.exitCode !== null) throw new Error("Browser exited: " + child.exitCode);
    await delay(100);
  }
  throw new Error("Timed out waiting for " + description);
}

async function run() {
  var port = await waitFor(function () {
    try { return Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch (_) { return 0; }
  }, "browser debugging port");
  var base = "http://127.0.0.1:" + port;
  var worker = await waitFor(async function () {
    var targets = await (await fetch(base + "/json/list")).json();
    return targets.find(function (target) {
      return target.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/src\/service-worker\.js$/.test(target.url);
    });
  }, "extension service worker");
  var extensionId = new URL(worker.url).hostname;
  assert.match(extensionId, /^[a-p]{32}$/);
  console.log("Extension loaded: " + extensionId + " " + worker.url);

  var version = await (await fetch(base + "/json/version")).json();
  var cdp = await connect(version.webSocketDebuggerUrl);
  var target = await cdp.send("Target.createTarget", { url: "about:blank" });
  var session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  var media = Buffer.alloc(800000);
  for (var i = 0; i < media.length; i++) media[i] = i % 251;
  var sidxMedia = Buffer.alloc(364);
  sidxMedia.writeUInt32BE(8, 0); sidxMedia.write("ftyp", 4, "ascii");
  sidxMedia.writeUInt32BE(56, 8); sidxMedia.write("sidx", 12, "ascii");
  sidxMedia.writeUInt32BE(1, 20); sidxMedia.writeUInt32BE(1000, 24);
  sidxMedia.writeUInt16BE(2, 38);
  sidxMedia.writeUInt32BE(100, 40); sidxMedia.writeUInt32BE(5000, 44); sidxMedia.writeUInt32BE(0x90000000, 48);
  sidxMedia.writeUInt32BE(200, 52); sidxMedia.writeUInt32BE(3000, 56); sidxMedia.writeUInt32BE(0x90000000, 60);
  sidxMedia.fill(17, 64, 164); sidxMedia.fill(29, 164, 364);
  var ranges = [];
  var badRanges = [];
  var sidxRanges = [];
  var alternateMediaRequests = 0;
  cdp.onEvent(function (message) {
    if (message.method === "Runtime.exceptionThrown") console.error("Browser exception:", message.params.exceptionDetails.text, message.params.exceptionDetails.exception && message.params.exceptionDetails.exception.description);
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== session) return;
    var request = message.params.request;
    var response = { requestId: message.params.requestId, responseCode: 200 };
    if (request.url === "https://www.douyin.com/") {
      response.responseHeaders = [{ name: "Content-Type", value: "text/html" }];
      response.body = Buffer.from("<!doctype html><title>DTR fixture</title><body>fixture</body>").toString("base64");
    } else if (request.url === "https://www.douyin.com/post-fixture") {
      response.responseHeaders = [{ name: "Content-Type", value: "application/json" }];
      response.body = Buffer.from(JSON.stringify({ method: request.method, body: request.postData })).toString("base64");
    } else if (request.url.startsWith("https://media.douyinvod.com/") ||
               request.url.startsWith("https://mirror.douyinvod.com/") ||
               request.url.startsWith("https://v5-dy-ov-experiment.zjcdn.com/")) {
      var header = Object.entries(request.headers).find(function (item) { return item[0].toLowerCase() === "range"; });
      var match = header && /^bytes=(\d+)-(\d+)$/.exec(header[1]);
      if (!match) throw new Error("Expected a single Range header");
      var start = Number(match[1]);
      var end = Number(match[2]);
      if (request.url.startsWith("https://mirror.douyinvod.com/") && end - start + 1 > 1024) {
        alternateMediaRequests += 1;
      }
      ranges.push([start, end]);
      var isBadFixture = request.url.endsWith("/bad-range");
      var isSidxFixture = request.url.endsWith("/sidx-fixture") || request.url.endsWith("/sidx-xhr");
      var fixtureBytes = isSidxFixture ? sidxMedia : media;
      if (isSidxFixture) sidxRanges.push([start, end]);
      if (isBadFixture) badRanges.push([start, end]);
      response.responseCode = 206;
      response.responseHeaders = [
        { name: "Access-Control-Allow-Origin", value: "*" },
        { name: "Access-Control-Expose-Headers", value: "Content-Range, ETag" },
        { name: "Content-Type", value: "video/mp4" },
        { name: "Content-Range", value: "bytes " + (isBadFixture && end - start + 1 < media.length ? 0 : start) + "-" + end + "/" + fixtureBytes.length },
        { name: "ETag", value: '"fixture"' }
      ];
      var responseBytes = Buffer.from(fixtureBytes.subarray(start, end + 1));
      if (request.url === "https://mirror.douyinvod.com/mismatch" && start > 0 && responseBytes.length) {
        responseBytes[0] ^= 1;
      }
      response.body = responseBytes.toString("base64");
    } else {
      response.responseCode = 404;
      response.body = "";
    }
    cdp.send("Fetch.fulfillRequest", response, session).catch(function (error) {
      // A sibling request can be cancelled while the fallback test fulfills it.
      if (error.message === "Invalid InterceptionId.") return;
      console.error(error);
      process.exitCode = 1;
    });
  });
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://www.douyin.com/*" }, { urlPattern: "https://media.douyinvod.com/*" }, { urlPattern: "https://mirror.douyinvod.com/*" }, { urlPattern: "https://v5-dy-ov-experiment.zjcdn.com/*" }] }, session);
  await cdp.send("Page.navigate", { url: "https://www.douyin.com/" }, session);

  async function evaluate(expression, targetSession) {
    var result = await cdp.send("Runtime.evaluate", {
      expression: expression, awaitPromise: true, returnByValue: true
    }, targetSession || session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  }

  try {
    await waitFor(function () { return evaluate("Boolean(window.__DTR__)"); }, "content script");
  } catch (error) {
    console.error("Page state:", await evaluate("({url: location.href, title: document.title, body: document.body && document.body.innerText, core: typeof window.DTRRangeCore, accel: typeof window.DTRFetchAccelerator})"));
    throw error;
  }
  var post = await evaluate(`(async () => {
    const request = new Request('https://www.douyin.com/post-fixture', { method: 'POST', body: 'post fixture text' });
    return await (await fetch(request)).json();
  })()`);
  assert.deepEqual(post, { method: "POST", body: "post fixture text" }, "POST body must pass through unchanged");
  var fixtureResult = await evaluate(`(async () => {
    const data = new Uint8Array(await (await fetch('https://media.douyinvod.com/test', {
      headers: { Range: 'bytes=0-799999' }, credentials: 'omit'
    })).arrayBuffer());
    let valid = data.length === 800000;
    for (let i = 0; i < data.length && valid; i++) valid = data[i] === i % 251;
    return { valid, stats: window.__DTR__.getStats() };
  })()`);
  assert.equal(fixtureResult.valid, true, "browser response bytes differ from fixture");
  assert.equal(fixtureResult.stats.accelerated, 1, "Range should be accelerated");
  assert.equal(ranges.length, 2, "expected two browser subrequests");

  await evaluate(`window.postMessage({ source: 'DTR_EXTENSION', type: 'DTR_CONFIG',
    config: { adaptiveConcurrency: false, maxRetries: 0 } }, '*')`);
  await waitFor(function () { return evaluate("window.__DTR__.getConfig().adaptiveConcurrency === false"); }, "fixture configuration");
  var fallback = await evaluate(`(async () => {
    const data = new Uint8Array(await (await fetch('https://media.douyinvod.com/bad-range', {
      headers: { Range: 'bytes=0-799999' }, credentials: 'omit'
    })).arrayBuffer());
    let valid = data.length === 800000;
    for (let i = 0; i < data.length && valid; i++) valid = data[i] === i % 251;
    return { valid, stats: window.__DTR__.getStats() };
  })()`);
  assert.equal(fallback.valid, true, "native fallback must return the original bytes");
  assert.equal(fallback.stats.fallbacks, 1, "malformed subrange must trigger fallback");
  assert.ok(badRanges.some(function (range) { return range[0] === 0 && range[1] === 799999; }),
    "fallback must request the original range");

  await evaluate(`window.__DTR__.observeMetadata({ video: { play_addr: { url_list: [
    'https://media.douyinvod.com/multicdn', 'https://mirror.douyinvod.com/multicdn'
  ] } } })`);
  await evaluate(`fetch('https://media.douyinvod.com/multicdn', {
    headers: { Range: 'bytes=0-127' }, credentials: 'omit'
  }).then(r => r.arrayBuffer())`);
  await waitFor(function () { return evaluate("window.__DTR__.getStats().resolver.stats.verifiedAlternates >= 1"); },
    "verified CDN alternate");
  var multiCdn = await evaluate(`(async () => {
    const data = new Uint8Array(await (await fetch('https://media.douyinvod.com/multicdn', {
      headers: { Range: 'bytes=0-799999' }, credentials: 'omit'
    })).arrayBuffer());
    let valid = data.length === 800000;
    for (let i = 0; i < data.length && valid; i++) valid = data[i] === i % 251;
    return { valid, stats: window.__DTR__.getStats() };
  })()`);
  assert.equal(multiCdn.valid, true, "multi-CDN response bytes must match");
  assert.ok(multiCdn.stats.resolver.stats.multiHostSelections >= 1 && alternateMediaRequests >= 1,
    "verified alternate must carry at least one media subrange");

  var alternateBeforeMismatch = alternateMediaRequests;
  await evaluate(`window.__DTR__.observeMetadata({ video: { play_addr: { url_list: [
    'https://media.douyinvod.com/mismatch', 'https://mirror.douyinvod.com/mismatch'
  ] } } })`);
  await evaluate(`fetch('https://media.douyinvod.com/mismatch', {
    headers: { Range: 'bytes=0-127' }, credentials: 'omit'
  }).then(r => r.arrayBuffer())`);
  await waitFor(function () { return evaluate("window.__DTR__.getStats().resolver.stats.rejectedAlternates >= 1"); },
    "rejected mismatched CDN alternate");
  var mismatch = await evaluate(`(async () => {
    const data = new Uint8Array(await (await fetch('https://media.douyinvod.com/mismatch', {
      headers: { Range: 'bytes=0-799999' }, credentials: 'omit'
    })).arrayBuffer());
    let valid = data.length === 800000;
    for (let i = 0; i < data.length && valid; i++) valid = data[i] === i % 251;
    return valid;
  })()`);
  assert.equal(mismatch, true, "mismatched alternate must not corrupt response bytes");
  assert.equal(alternateMediaRequests, alternateBeforeMismatch, "rejected alternate must not carry media subranges");

  await evaluate(`window.postMessage({ source: 'DTR_EXTENSION', type: 'DTR_CONFIG',
    config: { prefetchEnabled: true, prefetchSegments: 1, prefetchDelayMs: 0, multiCdnEnabled: false } }, '*')`);
  await waitFor(function () { return evaluate("window.__DTR__.getConfig().multiCdnEnabled === false"); }, "prefetch fixture configuration");
  await evaluate(`fetch('https://media.douyinvod.com/sidx-fixture', {
    headers: { Range: 'bytes=0-63' }, credentials: 'omit'
  }).then(r => r.arrayBuffer())`);
  await waitFor(function () { return evaluate("window.__DTR__.getStats().prefetch.indexCount >= 1"); }, "SIDX parsing");
  var firstSegment = await evaluate(`fetch('https://media.douyinvod.com/sidx-fixture', {
    headers: { Range: 'bytes=64-163' }, credentials: 'omit'
  }).then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)))`);
  assert.equal(firstSegment.length, 100);
  assert.ok(firstSegment.every(function (value) { return value === 17; }));
  await waitFor(function () { return evaluate("window.__DTR__.getStats().prefetch.cacheEntries >= 1"); }, "prefetch cache fill");
  var sidxRequestsBeforeHit = sidxRanges.length;
  var secondSegment = await evaluate(`fetch('https://media.douyinvod.com/sidx-fixture', {
    headers: { Range: 'bytes=164-363' }, credentials: 'omit'
  }).then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)))`);
  assert.equal(secondSegment.length, 200);
  assert.ok(secondSegment.every(function (value) { return value === 29; }));
  assert.equal(sidxRanges.length, sidxRequestsBeforeHit, "demand must reuse prefetched segment");
  assert.equal(await evaluate("window.__DTR__.getStats().prefetchHits"), 1);

  await evaluate(`(async () => {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://media.douyinvod.com/sidx-xhr');
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=0-63');
      xhr.onload = () => xhr.status === 206 ? resolve() : reject(new Error('unexpected XHR status'));
      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.send();
    });
  })()`);
  await waitFor(function () { return evaluate("window.__DTR__.getStats().prefetch.indexCount >= 2"); }, "XHR SIDX observation");
  await evaluate(`fetch('https://media.douyinvod.com/sidx-xhr', {
    headers: { Range: 'bytes=64-163' }, credentials: 'omit'
  }).then(r => r.arrayBuffer())`);
  await waitFor(function () { return evaluate("window.__DTR__.getStats().prefetch.cacheEntries >= 1"); }, "XHR-indexed prefetch");
  var beforeXhrHit = sidxRanges.length;
  var xhrIndexed = await evaluate(`fetch('https://media.douyinvod.com/sidx-xhr', {
    headers: { Range: 'bytes=164-363' }, credentials: 'omit'
  }).then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)))`);
  assert.equal(xhrIndexed.length, 200);
  assert.ok(xhrIndexed.every(function (value) { return value === 29; }));
  assert.equal(sidxRanges.length, beforeXhrHit, "XHR index must enable the next segment cache hit");
  assert.equal(await evaluate("window.__DTR__.getStats().prefetchHits"), 2);

  var zjBefore = await evaluate("window.__DTR__.getStats().accelerated");
  var zjBytes = await evaluate(`fetch('https://v5-dy-ov-experiment.zjcdn.com/abc/def/video/tos/cn/tos-cn-ve-15c000-ce/id/media-video-hvc1/?a=6383', {headers:{Range:'bytes=0-799999'},credentials:'omit',cache:'no-store'}).then(r=>r.arrayBuffer()).then(b=>{let a=new Uint8Array(b); return a.length===800000 && a.every((v,i)=>v===i%251)})`);
  assert.equal(zjBytes, true, "zjcdn reconstructed bytes differ");
  assert.equal(await evaluate("window.__DTR__.getStats().accelerated"), zjBefore + 1, "zjcdn media should be accelerated");

  var popup = await cdp.send("Target.createTarget", { url: "chrome-extension://" + extensionId + "/popup/popup.html" });
  var popupSession = (await cdp.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true })).sessionId;
  await waitFor(function () { return evaluate("Boolean(document.getElementById('enabled'))", popupSession); }, "popup");
  await evaluate(`(async () => {
    const enabled = document.getElementById('enabled');
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
  })()`, popupSession);
  await waitFor(function () { return evaluate("window.__DTR__.getConfig().enabled === false"); }, "popup configuration propagation");
  console.log("Browser fixture: POST, Range, fallback, CDN validation, SIDX prefetch and popup configuration passed");
  if (process.argv.includes("--live")) {
    await evaluate(`document.getElementById('enabled').click()`, popupSession);
    await waitFor(function () { return evaluate("window.__DTR__.getConfig().enabled === true"); }, "re-enabled configuration");
    await cdp.send("Fetch.disable", {}, session);
    var navigation = await cdp.send("Page.navigate", { url: "https://www.douyin.com/" }, session);
    if (navigation.errorText) throw new Error("Live navigation failed: " + navigation.errorText);
    await delay(15000);
    var live = await evaluate(`(() => {
      const video = document.querySelector('video');
      return { title: document.title, installed: !!window.__DTR__,
        video: video && { paused: video.paused, readyState: video.readyState, currentTime: video.currentTime },
        stats: window.__DTR__ && window.__DTR__.getStats() };
    })()`);
    console.log("Live page:", JSON.stringify({ title: live.title, installed: live.installed, video: live.video,
      matched: live.stats && live.stats.matchedRangeFetches, accelerated: live.stats && live.stats.accelerated,
      fallbacks: live.stats && live.stats.fallbacks }));
    assert.ok(live.installed && live.video && live.video.readyState >= 2, "live playable video not observed");
    await delay(4000);
    var later = await evaluate("document.querySelector('video') && document.querySelector('video').currentTime");
    assert.ok(later > live.video.currentTime, "live video did not advance");
    console.log("Live playback advanced successfully");
  }
  cdp.close();
}

run().then(function () { console.log("browser-smoke: ok"); }).catch(function (error) {
  console.error(error); process.exitCode = 1;
}).finally(async function () {
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise(function (resolve) { child.once("exit", resolve); }), delay(3000)]);
  // The path is a fresh, uniquely named directory created above, never user data.
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { console.error("Could not remove disposable profile: " + error.message); process.exitCode = 1; }
  if (packageDir) {
    try { fs.rmSync(packageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.error("Could not remove disposable package: " + error.message); process.exitCode = 1; }
  }
});
