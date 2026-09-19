(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    try {
      Object.defineProperty(root, "DTRSidx", {
        configurable: true,
        value: api
      });
    } catch (_) {
      root.DTRSidx = api;
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function readUint64(view, offset) {
    var high = view.getUint32(offset);
    var low = view.getUint32(offset + 4);
    var value = high * 4294967296 + low;
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("64-bit MP4 value exceeds safe integer range");
    }
    return value;
  }

  function parseSidx(input, absoluteStart) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var base = Number.isSafeInteger(absoluteStart) ? absoluteStart : 0;
    var offset = 0;

    while (offset + 8 <= bytes.byteLength) {
      var size = view.getUint32(offset);
      var type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      );
      var headerSize = 8;

      if (size === 1) {
        if (offset + 16 > bytes.byteLength) {
          return null;
        }
        size = readUint64(view, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = bytes.byteLength - offset;
      }

      if (!Number.isSafeInteger(size) || size < headerSize || offset + size > bytes.byteLength) {
        return null;
      }

      if (type === "sidx") {
        var cursor = offset + headerSize;
        if (cursor + 12 > offset + size) {
          return null;
        }

        var version = bytes[cursor];
        cursor += 4;

        var referenceId = view.getUint32(cursor);
        cursor += 4;

        var timescale = view.getUint32(cursor);
        cursor += 4;

        if (!timescale) {
          return null;
        }

        var earliestPresentationTime;
        var firstOffset;

        if (version === 0) {
          if (cursor + 8 > offset + size) {
            return null;
          }
          earliestPresentationTime = view.getUint32(cursor);
          firstOffset = view.getUint32(cursor + 4);
          cursor += 8;
        } else if (version === 1) {
          if (cursor + 16 > offset + size) {
            return null;
          }
          earliestPresentationTime = readUint64(view, cursor);
          firstOffset = readUint64(view, cursor + 8);
          cursor += 16;
        } else {
          return null;
        }

        if (cursor + 4 > offset + size) {
          return null;
        }

        cursor += 2;
        var referenceCount = view.getUint16(cursor);
        cursor += 2;

        var byteCursor = base + offset + size + firstOffset;
        var timeCursor = earliestPresentationTime;
        var segments = [];

        for (var i = 0; i < referenceCount; i += 1) {
          if (cursor + 12 > offset + size) {
            return null;
          }

          var reference = view.getUint32(cursor);
          var duration = view.getUint32(cursor + 4);
          var sap = view.getUint32(cursor + 8);
          cursor += 12;

          var referenceType = reference >>> 31;
          var referencedSize = reference & 0x7fffffff;

          if (referenceType === 0 && referencedSize > 0) {
            segments.push({
              index: segments.length,
              start: byteCursor,
              end: byteCursor + referencedSize - 1,
              length: referencedSize,
              startTime: timeCursor / timescale,
              endTime: (timeCursor + duration) / timescale,
              duration: duration / timescale,
              startsWithSap: Boolean(sap >>> 31)
            });
          }

          byteCursor += referencedSize;
          timeCursor += duration;
        }

        return {
          version: version,
          referenceId: referenceId,
          timescale: timescale,
          earliestPresentationTime: earliestPresentationTime,
          firstOffset: firstOffset,
          referenceCount: referenceCount,
          boxStart: base + offset,
          boxEnd: base + offset + size - 1,
          segments: segments
        };
      }

      offset += size;
    }

    return null;
  }

  return Object.freeze({
    parseSidx: parseSidx
  });
});
