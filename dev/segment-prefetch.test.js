"use strict";

var assert = require("node:assert/strict");
var prefetchApi = require("../src/segment-prefetch.js");

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

var state = prefetchApi.createPrefetchState({
  maxCacheBytes: 1024 * 1024,
  ttlMs: 30000
});

var parsed = state.observeIndex(
  "/video/test/media-video-hvc1/",
  { start: 0, end: 63, length: 64 },
  makeSidx()
);

assert.ok(parsed);
var first = parsed.segments[0];
var second = parsed.segments[1];

assert.equal(state.matchSegment("/video/test/media-video-hvc1/", first).index, 0);
assert.deepEqual(
  state.nextSegments("/video/test/media-video-hvc1/", 0, 1)[0],
  second
);

var g1 = state.noteDemand("/video/test/media-video-hvc1/", 0);
assert.equal(state.isGenerationCurrent("/video/test/media-video-hvc1/", g1), true);

var g2 = state.noteDemand("/video/test/media-video-hvc1/", 1);
assert.equal(state.isGenerationCurrent("/video/test/media-video-hvc1/", g1), false);
assert.equal(state.isGenerationCurrent("/video/test/media-video-hvc1/", g2), true);

state.put("/video/test/media-video-hvc1/", second, {
  bytes: new Uint8Array(second.length),
  headers: new Headers(),
  statusText: "Partial Content",
  total: 1000
});

assert.equal(state.has("/video/test/media-video-hvc1/", second), true);
var hit = state.take("/video/test/media-video-hvc1/", second);
assert.ok(hit);
assert.equal(hit.bytes.byteLength, second.length);
assert.equal(state.has("/video/test/media-video-hvc1/", second), false);

// Replacing a cached entry must not let eviction count the old entry twice.
var bounded = prefetchApi.createPrefetchState({ maxCacheBytes: 1024 * 1024 });
var a = { start: 0, end: 599999 };
var b = { start: 600000, end: 999999 };
bounded.put("a", a, { bytes: new Uint8Array(600000) });
bounded.put("b", b, { bytes: new Uint8Array(400000) });
bounded.put("a", a, { bytes: new Uint8Array(700000) });
var remainingBytes = 0;
[ ["a", a], ["b", b] ].forEach(function (item) {
  var entry = bounded.take(item[0], item[1]);
  if (entry) remainingBytes += entry.bytes.byteLength;
});
assert.ok(remainingBytes <= 1024 * 1024, "cache must respect its byte limit after replacement");
assert.equal(bounded.snapshot().stats.cachedBytes, 0);

var preserve = prefetchApi.createPrefetchState({ maxCacheBytes: 1024 * 1024 });
preserve.put("a", a, { bytes: new Uint8Array(600000) });
assert.equal(preserve.put("a", a, { bytes: new Uint8Array(1100000) }), false);
assert.equal(preserve.snapshot().stats.cachedBytes, 600000, "failed replacement must preserve byte accounting");
assert.equal(preserve.take("a", a).bytes.byteLength, 600000);

var generationState = prefetchApi.createPrefetchState();
var obsoleteGeneration = generationState.noteDemand("resource", 0);
generationState.clear();
generationState.noteDemand("resource", 0);
assert.equal(generationState.isGenerationCurrent("resource", obsoleteGeneration), false,
  "clearing must not let a delayed old task match a new generation");

var limitedIndexes = prefetchApi.createPrefetchState({ maxIndexes: 2 });
["a", "b", "c"].forEach(function (key) {
  assert.ok(limitedIndexes.observeIndex(key, { start: 0, end: 63, length: 64 }, makeSidx()));
});
assert.equal(limitedIndexes.snapshot().indexCount, 2, "old SIDX indexes must be bounded");
assert.equal(limitedIndexes.getIndex("a"), null);
assert.ok(limitedIndexes.getIndex("c"));
assert.ok(limitedIndexes.getIndex("b"));
assert.ok(limitedIndexes.observeIndex("d", { start: 0, end: 63, length: 64 }, makeSidx()));
assert.equal(limitedIndexes.getIndex("c"), null, "least recently used index must be evicted");
assert.ok(limitedIndexes.getIndex("b"), "recently used index must remain available");

var boundedGenerations = prefetchApi.createPrefetchState();
var firstGeneration = boundedGenerations.noteDemand("first", 0);
for (var n = 0; n < 300; n += 1) boundedGenerations.noteDemand("video-" + n, 0);
assert.equal(boundedGenerations.isGenerationCurrent("first", firstGeneration), false,
  "old demand generations must be discarded during long sessions");

console.log("segment-prefetch.test.js: ok");
