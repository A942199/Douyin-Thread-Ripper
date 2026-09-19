"use strict";

var assert = require("node:assert/strict");
var sidx = require("../src/sidx.js");

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

  return Buffer.concat([
    makeBox("ftyp", Buffer.alloc(0)),
    makeBox("sidx", payload)
  ]);
}

var bytes = makeSidx();
var parsed = sidx.parseSidx(bytes, 0);

assert.ok(parsed);
assert.equal(parsed.timescale, 1000);
assert.equal(parsed.referenceCount, 2);
assert.equal(parsed.segments.length, 2);
assert.deepEqual(parsed.segments.map(function (x) {
  return {
    start: x.start,
    end: x.end,
    length: x.length,
    startTime: x.startTime,
    endTime: x.endTime
  };
}), [
  { start: 64, end: 163, length: 100, startTime: 0, endTime: 5 },
  { start: 164, end: 363, length: 200, startTime: 5, endTime: 8 }
]);

console.log("sidx.test.js: ok");
