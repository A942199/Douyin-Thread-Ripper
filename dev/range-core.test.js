"use strict";

var assert = require("node:assert/strict");
var core = require("../src/range-core.js");

assert.deepEqual(core.parseRangeHeader("bytes=0-65535"), {
  start: 0,
  end: 65535,
  length: 65536
});
assert.equal(core.parseRangeHeader("bytes=0-"), null);
assert.equal(core.parseRangeHeader("bytes=-65535"), null);
assert.equal(core.parseRangeHeader("bytes=9-4"), null);

assert.deepEqual(core.parseContentRange("bytes 100-199/1000"), {
  start: 100,
  end: 199,
  total: 1000,
  length: 100
});
assert.equal(core.parseContentRange("bytes 100-100/100"), null);

var pieces = core.splitRange(100, 109, 3);
assert.deepEqual(pieces, [
  { index: 0, start: 100, end: 103, length: 4 },
  { index: 1, start: 104, end: 106, length: 3 },
  { index: 2, start: 107, end: 109, length: 3 }
]);

assert.equal(core.choosePieceCount(200 * 1024, {
  minSplitBytes: 256 * 1024,
  targetChunkBytes: 192 * 1024,
  maxPieces: 4
}), 1);

assert.equal(core.choosePieceCount(700 * 1024, {
  minSplitBytes: 256 * 1024,
  targetChunkBytes: 192 * 1024,
  maxPieces: 4
}), 4);

var joined = core.concatUint8Arrays([
  new Uint8Array([1, 2]),
  new Uint8Array([3, 4])
], 4);
assert.deepEqual(Array.from(joined), [1, 2, 3, 4]);

assert.equal(core.isDouyinVodHost("v3-web-prime.douyinvod.com"), true);
assert.equal(core.isDouyinVodHost("douyinvod.com"), true);
assert.equal(core.isDouyinVodHost("www.douyin.com"), false);

console.log("range-core.test.js: ok");
