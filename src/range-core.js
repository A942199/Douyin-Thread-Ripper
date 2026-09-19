(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    try {
      Object.defineProperty(root, "DTRRangeCore", {
        configurable: true,
        value: api
      });
    } catch (_) {
      root.DTRRangeCore = api;
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BYTE_RANGE_RE = /^\s*bytes=(\d+)-(\d+)\s*$/i;
  var CONTENT_RANGE_RE = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i;

  function toSafeInteger(value) {
    var n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      return null;
    }
    return n;
  }

  function parseRangeHeader(value) {
    if (typeof value !== "string") {
      return null;
    }

    var match = BYTE_RANGE_RE.exec(value);
    if (!match) {
      return null;
    }

    var start = toSafeInteger(match[1]);
    var end = toSafeInteger(match[2]);
    if (start === null || end === null || end < start) {
      return null;
    }

    return {
      start: start,
      end: end,
      length: end - start + 1
    };
  }

  function parseContentRange(value) {
    if (typeof value !== "string") {
      return null;
    }

    var match = CONTENT_RANGE_RE.exec(value);
    if (!match) {
      return null;
    }

    var start = toSafeInteger(match[1]);
    var end = toSafeInteger(match[2]);
    var total = match[3] === "*" ? null : toSafeInteger(match[3]);

    if (start === null || end === null || end < start) {
      return null;
    }
    if (total !== null && end >= total) {
      return null;
    }

    return {
      start: start,
      end: end,
      total: total,
      length: end - start + 1
    };
  }

  function formatRange(start, end) {
    return "bytes=" + String(start) + "-" + String(end);
  }

  function splitRange(start, end, requestedCount) {
    var s = toSafeInteger(start);
    var e = toSafeInteger(end);
    var count = Math.floor(Number(requestedCount));

    if (s === null || e === null || e < s) {
      throw new TypeError("Invalid byte range");
    }
    if (!Number.isFinite(count) || count < 1) {
      throw new TypeError("Invalid piece count");
    }

    var length = e - s + 1;
    count = Math.min(count, length);

    var base = Math.floor(length / count);
    var remainder = length % count;
    var cursor = s;
    var pieces = [];

    for (var i = 0; i < count; i += 1) {
      var size = base + (i < remainder ? 1 : 0);
      var pieceEnd = cursor + size - 1;
      pieces.push({
        index: i,
        start: cursor,
        end: pieceEnd,
        length: size
      });
      cursor = pieceEnd + 1;
    }

    if (cursor !== e + 1) {
      throw new Error("Range split invariant failed");
    }

    return pieces;
  }

  function choosePieceCount(length, config) {
    var size = Number(length);
    var cfg = config || {};
    var minSplitBytes = Math.max(1, Number(cfg.minSplitBytes) || 512 * 1024);
    var targetChunkBytes = Math.max(1, Number(cfg.targetChunkBytes) || 256 * 1024);
    var maxPieces = Math.max(1, Math.floor(Number(cfg.maxPieces) || 3));

    if (!Number.isSafeInteger(size) || size < minSplitBytes || maxPieces < 2) {
      return 1;
    }

    return Math.min(maxPieces, Math.max(2, Math.ceil(size / targetChunkBytes)));
  }

  function concatUint8Arrays(parts, expectedLength) {
    if (!Array.isArray(parts)) {
      throw new TypeError("parts must be an array");
    }

    var total = 0;
    for (var i = 0; i < parts.length; i += 1) {
      if (!(parts[i] instanceof Uint8Array)) {
        throw new TypeError("Every part must be Uint8Array");
      }
      total += parts[i].byteLength;
    }

    if (expectedLength !== undefined && total !== expectedLength) {
      throw new Error("Concatenated byte length mismatch");
    }

    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j += 1) {
      out.set(parts[j], offset);
      offset += parts[j].byteLength;
    }
    return out;
  }

  function isDouyinVodHost(hostname) {
    if (typeof hostname !== "string") {
      return false;
    }

    var host = hostname.toLowerCase();
    return host === "douyinvod.com" || host.endsWith(".douyinvod.com");
  }

  function sanitizeUrl(value) {
    try {
      var url = new URL(value);
      return {
        host: url.hostname,
        path: url.pathname
      };
    } catch (_) {
      return {
        host: "",
        path: ""
      };
    }
  }

  function validatePiece(piece, contentRange, byteLength) {
    if (!piece || !contentRange) {
      return false;
    }

    return (
      contentRange.start === piece.start &&
      contentRange.end === piece.end &&
      contentRange.length === piece.length &&
      byteLength === piece.length
    );
  }

  return Object.freeze({
    parseRangeHeader: parseRangeHeader,
    parseContentRange: parseContentRange,
    formatRange: formatRange,
    splitRange: splitRange,
    choosePieceCount: choosePieceCount,
    concatUint8Arrays: concatUint8Arrays,
    isDouyinVodHost: isDouyinVodHost,
    sanitizeUrl: sanitizeUrl,
    validatePiece: validatePiece
  });
});
