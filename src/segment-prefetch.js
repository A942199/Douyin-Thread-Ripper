(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./sidx.js"));
    return;
  }

  var api = factory(root && root.DTRSidx);

  if (root) {
    try {
      Object.defineProperty(root, "DTRSegmentPrefetch", {
        configurable: true,
        value: api
      });
    } catch (_) {
      root.DTRSegmentPrefetch = api;
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (sidxApi) {
  "use strict";

  if (!sidxApi) {
    throw new Error("DTRSidx is required");
  }

  function rangeKey(resourceKey, range) {
    return resourceKey + ":" + String(range.start) + "-" + String(range.end);
  }

  function createPrefetchState(options) {
    var opts = options || {};
    var maxCacheBytes = Math.max(1024 * 1024, Number(opts.maxCacheBytes) || 16 * 1024 * 1024);
    var ttlMs = Math.max(5000, Number(opts.ttlMs) || 30000);

    var indexes = new Map();
    var cache = new Map();
    var inflight = new Map();
    var demandGenerations = new Map();
    var cacheBytes = 0;

    var stats = {
      indexesParsed: 0,
      scheduled: 0,
      completed: 0,
      hits: 0,
      joinedInflight: 0,
      abortedStale: 0,
      evictions: 0,
      cachedBytes: 0
    };

    function cleanupExpired() {
      var cutoff = Date.now() - ttlMs;
      cache.forEach(function (entry, key) {
        if (entry.createdAt < cutoff) {
          cache.delete(key);
          cacheBytes -= entry.bytes.byteLength;
          stats.evictions += 1;
        }
      });
      stats.cachedBytes = Math.max(0, cacheBytes);
    }

    function evictToFit(extraBytes) {
      cleanupExpired();
      if (extraBytes > maxCacheBytes) {
        return false;
      }

      while (cacheBytes + extraBytes > maxCacheBytes && cache.size) {
        var oldestKey = null;
        var oldestAt = Number.POSITIVE_INFINITY;
        cache.forEach(function (entry, key) {
          if (entry.createdAt < oldestAt) {
            oldestAt = entry.createdAt;
            oldestKey = key;
          }
        });
        if (oldestKey === null) {
          break;
        }
        var old = cache.get(oldestKey);
        cache.delete(oldestKey);
        cacheBytes -= old.bytes.byteLength;
        stats.evictions += 1;
      }
      return cacheBytes + extraBytes <= maxCacheBytes;
    }

    function observeIndex(resourceKey, range, bytes) {
      if (!resourceKey || !range || !bytes) {
        return null;
      }
      var parsed = sidxApi.parseSidx(bytes, range.start);
      if (!parsed || !parsed.segments || !parsed.segments.length) {
        return null;
      }
      indexes.set(resourceKey, parsed);
      stats.indexesParsed += 1;
      return parsed;
    }

    function getIndex(resourceKey) {
      return indexes.get(resourceKey) || null;
    }

    function matchSegment(resourceKey, range) {
      var parsed = indexes.get(resourceKey);
      if (!parsed || !range) {
        return null;
      }
      for (var i = 0; i < parsed.segments.length; i += 1) {
        var segment = parsed.segments[i];
        if (segment.start === range.start && segment.end === range.end) {
          return segment;
        }
      }
      return null;
    }

    function nextSegments(resourceKey, currentIndex, count) {
      var parsed = indexes.get(resourceKey);
      if (!parsed) {
        return [];
      }
      var wanted = Math.max(0, Math.floor(Number(count) || 0));
      return parsed.segments.slice(currentIndex + 1, currentIndex + 1 + wanted);
    }

    function put(resourceKey, range, value) {
      if (!value || !(value.bytes instanceof Uint8Array)) {
        return false;
      }
      var key = rangeKey(resourceKey, range);
      var previous = cache.get(key);
      if (previous) {
        cacheBytes -= previous.bytes.byteLength;
      }

      if (!evictToFit(value.bytes.byteLength)) {
        if (previous) {
          cache.set(key, previous);
          cacheBytes += previous.bytes.byteLength;
        }
        return false;
      }

      cache.set(key, {
        bytes: value.bytes,
        headers: value.headers,
        statusText: value.statusText,
        total: value.total,
        createdAt: Date.now(),
        segmentIndex: range.index
      });
      cacheBytes += value.bytes.byteLength;
      stats.cachedBytes = cacheBytes;
      stats.completed += 1;
      return true;
    }

    function has(resourceKey, range) {
      cleanupExpired();
      return cache.has(rangeKey(resourceKey, range));
    }

    function take(resourceKey, range) {
      cleanupExpired();
      var key = rangeKey(resourceKey, range);
      var entry = cache.get(key);
      if (!entry) {
        return null;
      }
      cache.delete(key);
      cacheBytes -= entry.bytes.byteLength;
      stats.cachedBytes = Math.max(0, cacheBytes);
      stats.hits += 1;
      return entry;
    }

    function getInflight(resourceKey, range) {
      return inflight.get(rangeKey(resourceKey, range)) || null;
    }

    function setInflight(resourceKey, range, promise, controller) {
      var key = rangeKey(resourceKey, range);
      var record = {
        resourceKey: resourceKey,
        range: range,
        promise: promise,
        controller: controller,
        createdAt: Date.now()
      };
      inflight.set(key, record);
      stats.scheduled += 1;
      Promise.resolve(promise).finally(function () {
        if (inflight.get(key) === record) {
          inflight.delete(key);
        }
      }).catch(function () {});
      return record;
    }

    function noteDemand(resourceKey, segmentIndex) {
      var previous = demandGenerations.get(resourceKey);
      var generation = previous ? previous.generation + 1 : 1;
      demandGenerations.set(resourceKey, {
        generation: generation,
        segmentIndex: segmentIndex
      });
      return generation;
    }

    function isGenerationCurrent(resourceKey, generation) {
      var state = demandGenerations.get(resourceKey);
      return Boolean(state && state.generation === generation);
    }

    function abortStale(resourceKey, currentIndex, radius) {
      var keepRadius = Math.max(1, Math.floor(Number(radius) || 2));
      inflight.forEach(function (record, key) {
        if (record.resourceKey !== resourceKey || !record.range) {
          return;
        }
        var index = Number(record.range.index);
        if (!Number.isFinite(index) || Math.abs(index - currentIndex) <= keepRadius) {
          return;
        }
        try {
          record.controller.abort();
        } catch (_) {
          // Best effort only.
        }
        inflight.delete(key);
        stats.abortedStale += 1;
      });
    }

    function abortOtherResources(activeKeys) {
      var allowed = new Set(activeKeys || []);
      inflight.forEach(function (record, key) {
        if (allowed.has(record.resourceKey)) {
          return;
        }
        try {
          record.controller.abort();
        } catch (_) {
          // Best effort only.
        }
        inflight.delete(key);
        stats.abortedStale += 1;
      });
    }

    function clear() {
      inflight.forEach(function (record) {
        try {
          record.controller.abort();
        } catch (_) {}
      });
      indexes.clear();
      cache.clear();
      inflight.clear();
      demandGenerations.clear();
      cacheBytes = 0;
      stats.cachedBytes = 0;
    }

    function snapshot() {
      cleanupExpired();
      return {
        stats: Object.assign({}, stats),
        indexCount: indexes.size,
        cacheEntries: cache.size,
        inflight: inflight.size
      };
    }

    return {
      observeIndex: observeIndex,
      getIndex: getIndex,
      matchSegment: matchSegment,
      nextSegments: nextSegments,
      put: put,
      has: has,
      take: take,
      getInflight: getInflight,
      setInflight: setInflight,
      noteDemand: noteDemand,
      isGenerationCurrent: isGenerationCurrent,
      abortStale: abortStale,
      abortOtherResources: abortOtherResources,
      clear: clear,
      snapshot: snapshot
    };
  }

  return Object.freeze({
    createPrefetchState: createPrefetchState
  });
});
