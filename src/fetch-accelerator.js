(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./range-core.js"),
      require("./cdn-resolver.js"),
      require("./segment-prefetch.js")
    );
  } else {
    root.DTRFetchAccelerator = factory(
      root.DTRRangeCore,
      root.DTRCdnResolver,
      root.DTRSegmentPrefetch
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (core, resolverApi, prefetchApi) {
  "use strict";

  if (!core || !resolverApi || !prefetchApi) {
    throw new Error("DTR RangeCore, CdnResolver and SegmentPrefetch are required");
  }

  var VERSION = "0.2.3";

  var DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    adaptiveConcurrency: true,
    multiCdnEnabled: true,
    prefetchEnabled: true,
    prefetchSegments: 1,
    prefetchWaitMs: 120,
    prefetchDelayMs: 60,
    prefetchCacheBytes: 16 * 1024 * 1024,
    minSplitBytes: 512 * 1024,
    slowMinSplitBytes: 320 * 1024,
    targetChunkBytes: 256 * 1024,
    maxPieces: 3,
    globalConcurrency: 6,
    timeoutMs: 8000,
    maxRetries: 1,
    maxRangeBytes: 8 * 1024 * 1024,
    fastTtfbMs: 60,
    threeWayTtfbMs: 180,
    debug: false
  });

  var METADATA_PATHS = [
    "/aweme/v1/web/tab/feed/",
    "/aweme/v1/web/aweme/detail/",
    "/aweme/v1/web/module/feed/"
  ];

  function clampInteger(value, fallback, min, max) {
    var n = Math.floor(Number(value));
    if (!Number.isFinite(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  }

  function normalizeConfig(input) {
    var value = input || {};
    return {
      enabled: value.enabled !== false,
      adaptiveConcurrency: value.adaptiveConcurrency !== false,
      multiCdnEnabled: value.multiCdnEnabled !== false,
      prefetchEnabled: value.prefetchEnabled !== false,
      prefetchSegments: clampInteger(value.prefetchSegments, DEFAULT_CONFIG.prefetchSegments, 0, 2),
      prefetchWaitMs: clampInteger(value.prefetchWaitMs, DEFAULT_CONFIG.prefetchWaitMs, 20, 1000),
      prefetchDelayMs: clampInteger(value.prefetchDelayMs, DEFAULT_CONFIG.prefetchDelayMs, 0, 2000),
      prefetchCacheBytes: clampInteger(
        value.prefetchCacheBytes,
        DEFAULT_CONFIG.prefetchCacheBytes,
        2 * 1024 * 1024,
        64 * 1024 * 1024
      ),
      minSplitBytes: clampInteger(value.minSplitBytes, DEFAULT_CONFIG.minSplitBytes, 64 * 1024, 8 * 1024 * 1024),
      slowMinSplitBytes: clampInteger(
        value.slowMinSplitBytes,
        DEFAULT_CONFIG.slowMinSplitBytes,
        128 * 1024,
        2 * 1024 * 1024
      ),
      targetChunkBytes: clampInteger(value.targetChunkBytes, DEFAULT_CONFIG.targetChunkBytes, 64 * 1024, 2 * 1024 * 1024),
      maxPieces: clampInteger(value.maxPieces, DEFAULT_CONFIG.maxPieces, 1, 3),
      globalConcurrency: clampInteger(value.globalConcurrency, DEFAULT_CONFIG.globalConcurrency, 1, 12),
      timeoutMs: clampInteger(value.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 30000),
      maxRetries: clampInteger(value.maxRetries, DEFAULT_CONFIG.maxRetries, 0, 2),
      maxRangeBytes: clampInteger(value.maxRangeBytes, DEFAULT_CONFIG.maxRangeBytes, 256 * 1024, 64 * 1024 * 1024),
      fastTtfbMs: clampInteger(value.fastTtfbMs, DEFAULT_CONFIG.fastTtfbMs, 10, 500),
      threeWayTtfbMs: clampInteger(value.threeWayTtfbMs, DEFAULT_CONFIG.threeWayTtfbMs, 50, 1500),
      debug: value.debug === true
    };
  }

  function now() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  function createAbortError(reason) {
    if (reason instanceof Error) {
      return reason;
    }
    if (typeof DOMException === "function") {
      return new DOMException("The operation was aborted.", "AbortError");
    }
    var error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }

  function isAbortError(error) {
    return Boolean(error && error.name === "AbortError");
  }

  function createSemaphore(initialLimit) {
    var limit = initialLimit;
    var active = 0;
    var queue = [];

    function drain() {
      while (active < limit && queue.length > 0) {
        var ticket = queue.shift();

        if (ticket.signal && ticket.signal.aborted) {
          ticket.reject(createAbortError(ticket.signal.reason));
          continue;
        }

        if (ticket.signal && ticket.onAbort) {
          ticket.signal.removeEventListener("abort", ticket.onAbort);
        }

        active += 1;
        var released = false;
        ticket.resolve(function release() {
          if (released) {
            return;
          }
          released = true;
          active = Math.max(0, active - 1);
          drain();
        });
      }
    }

    function acquire(signal) {
      if (signal && signal.aborted) {
        return Promise.reject(createAbortError(signal.reason));
      }

      return new Promise(function (resolve, reject) {
        var ticket = {
          resolve: resolve,
          reject: reject,
          signal: signal,
          onAbort: null
        };

        if (signal) {
          ticket.onAbort = function () {
            var index = queue.indexOf(ticket);
            if (index >= 0) {
              queue.splice(index, 1);
            }
            reject(createAbortError(signal.reason));
          };
          signal.addEventListener("abort", ticket.onAbort, { once: true });
        }

        queue.push(ticket);
        drain();
      });
    }

    return {
      async run(task, signal) {
        var release = await acquire(signal);
        try {
          return await task();
        } finally {
          release();
        }
      },
      setLimit(nextLimit) {
        limit = Math.max(1, Math.floor(Number(nextLimit) || 1));
        drain();
      },
      snapshot() {
        return {
          limit: limit,
          active: active,
          queued: queue.length
        };
      }
    };
  }

  function sleep(ms, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(createAbortError(signal.reason));
    }

    return new Promise(function (resolve, reject) {
      var timer = setTimeout(done, ms);

      function done() {
        cleanup();
        resolve();
      }

      function aborted() {
        clearTimeout(timer);
        cleanup();
        reject(createAbortError(signal && signal.reason));
      }

      function cleanup() {
        if (signal) {
          signal.removeEventListener("abort", aborted);
        }
      }

      if (signal) {
        signal.addEventListener("abort", aborted, { once: true });
      }
    });
  }

  function createTimedSignal(parentSignal, timeoutMs) {
    var controller = new AbortController();
    var timer = null;
    var onParentAbort = null;

    if (parentSignal) {
      onParentAbort = function () {
        controller.abort(parentSignal.reason);
      };
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    timer = setTimeout(function () {
      var error = new Error("Range sub-request timed out");
      error.name = "TimeoutError";
      controller.abort(error);
    }, timeoutMs);

    return {
      signal: controller.signal,
      cleanup: function () {
        clearTimeout(timer);
        if (parentSignal && onParentAbort) {
          parentSignal.removeEventListener("abort", onParentAbort);
        }
      }
    };
  }

  function PieceHttpError(status) {
    this.name = "PieceHttpError";
    this.message = "Unexpected sub-range HTTP status " + String(status);
    this.status = status;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PieceHttpError);
    }
  }
  PieceHttpError.prototype = Object.create(Error.prototype);
  PieceHttpError.prototype.constructor = PieceHttpError;

  function shouldRetry(error) {
    if (!error || isAbortError(error)) {
      return false;
    }
    if (error.name === "TimeoutError") {
      return true;
    }
    if (error instanceof PieceHttpError) {
      return (
        error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        (error.status >= 500 && error.status <= 599)
      );
    }
    return true;
  }

  function cloneStats(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isMetadataUrl(urlValue) {
    try {
      var url = new URL(urlValue);
      if (url.hostname !== "www.douyin.com") {
        return false;
      }
      return METADATA_PATHS.some(function (path) {
        return url.pathname === path;
      });
    } catch (_) {
      return false;
    }
  }

  function resourceKey(urlValue) {
    try {
      return new URL(urlValue).pathname;
    } catch (_) {
      return "";
    }
  }

  function copyRequestWithUrl(baseRequest, urlValue, headers, signal) {
    return new Request(urlValue, {
      method: baseRequest.method,
      headers: headers,
      mode: baseRequest.mode,
      credentials: baseRequest.credentials,
      cache: baseRequest.cache,
      redirect: baseRequest.redirect,
      referrer: baseRequest.referrer,
      referrerPolicy: baseRequest.referrerPolicy,
      integrity: baseRequest.integrity,
      keepalive: baseRequest.keepalive,
      signal: signal
    });
  }

  function createFetchAccelerator(options) {
    var opts = options || {};
    var nativeFetch = opts.nativeFetch;
    if (typeof nativeFetch !== "function") {
      throw new TypeError("nativeFetch is required");
    }

    var onStats = typeof opts.onStats === "function" ? opts.onStats : null;
    var config = normalizeConfig(Object.assign({}, DEFAULT_CONFIG, opts.config || {}));
    var semaphore = createSemaphore(config.globalConcurrency);
    var resolver = resolverApi.createResolver({
      nativeFetch: nativeFetch,
      probeBytes: 1024
    });
    var prefetch = prefetchApi.createPrefetchState({
      maxCacheBytes: config.prefetchCacheBytes,
      ttlMs: 30000
    });
    var activeResources = new Map();
    var ACTIVE_RESOURCE_GRACE_MS = 1500;

    function touchActiveResource(key) {
      var timestamp = Date.now();
      activeResources.set(key, timestamp);

      activeResources.forEach(function (seenAt, resource) {
        if (timestamp - seenAt > ACTIVE_RESOURCE_GRACE_MS) {
          activeResources.delete(resource);
        }
      });

      prefetch.abortOtherResources(Array.from(activeResources.keys()));
    }

    var stats = {
      version: VERSION,
      installedAt: Date.now(),
      totalFetches: 0,
      metadataObserved: 0,
      mediaIndexesObserved: 0,
      matchedRangeFetches: 0,
      accelerated: 0,
      adaptiveNative: 0,
      adaptive2Way: 0,
      adaptive3Way: 0,
      fallbacks: 0,
      failures: 0,
      bypassedSmall: 0,
      bypassedLarge: 0,
      subrequests: 0,
      retries: 0,
      bytesAccelerated: 0,
      prefetchHits: 0,
      prefetchJoined: 0,
      prefetchBytesServed: 0,
      last: null
    };

    function debugLog() {
      if (!config.debug || typeof console === "undefined" || typeof console.debug !== "function") {
        return;
      }
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[DTR]");
      console.debug.apply(console, args);
    }

    function getStatsSnapshot() {
      var snapshot = cloneStats(stats);
      snapshot.semaphore = semaphore.snapshot();
      snapshot.resolver = resolver.snapshot();
      snapshot.prefetch = prefetch.snapshot();
      return snapshot;
    }

    function publish() {
      if (!onStats) {
        return;
      }
      try {
        onStats(getStatsSnapshot());
      } catch (_) {
        // Observability must never affect playback.
      }
    }

    function observeMetadata(payload) {
      if (!payload || typeof payload !== "object") {
        return;
      }
      try {
        resolver.observeMetadata(payload);
        stats.metadataObserved += 1;
        publish();
      } catch (_) {
        // Metadata observation is advisory only.
      }
    }

    function observeMetadataResponse(response) {
      try {
        response.clone().json().then(observeMetadata).catch(function () {});
      } catch (_) {}
    }

    function observeMediaIndex(urlValue, rangeValue, bytesValue) {
      var parsedUrl;
      try {
        parsedUrl = new URL(urlValue);
      } catch (_) {
        return null;
      }

      if (!core.isDouyinVodHost(parsedUrl.hostname)) {
        return null;
      }

      var requestedRange = typeof rangeValue === "string"
        ? core.parseRangeHeader(rangeValue)
        : rangeValue;

      if (
        !requestedRange ||
        requestedRange.length > 128 * 1024
      ) {
        return null;
      }

      var bytes = null;
      if (bytesValue instanceof Uint8Array) {
        bytes = bytesValue;
      } else if (
        typeof ArrayBuffer !== "undefined" &&
        bytesValue instanceof ArrayBuffer
      ) {
        bytes = new Uint8Array(bytesValue);
      } else if (
        typeof ArrayBuffer !== "undefined" &&
        ArrayBuffer.isView &&
        ArrayBuffer.isView(bytesValue)
      ) {
        bytes = new Uint8Array(
          bytesValue.buffer,
          bytesValue.byteOffset,
          bytesValue.byteLength
        );
      }

      if (!bytes || !bytes.byteLength) {
        return null;
      }

      var parsed = prefetch.observeIndex(
        resourceKey(urlValue),
        requestedRange,
        bytes
      );

      if (parsed) {
        resolver.observePlayableUrl(urlValue);
        stats.mediaIndexesObserved += 1;
        publish();
      }

      return parsed;
    }

    function chooseAdaptivePieceCount(primaryUrl, length) {
      if (config.maxPieces < 2) {
        return 1;
      }

      if (!config.adaptiveConcurrency) {
        return core.choosePieceCount(length, config);
      }

      var candidates = config.multiCdnEnabled
        ? resolver.getCandidates(primaryUrl, true)
        : [primaryUrl];
      var health = resolver.getPrimaryHealth(primaryUrl);

      if (length < config.slowMinSplitBytes) {
        return 1;
      }

      if (length < config.minSplitBytes) {
        if (!health || Number(health.samples) < 2) {
          return 1;
        }

        var midTtfb = Number(health.ewmaTtfbMs);
        var midFailures = Number(health.failures) || 0;
        var midSamples = Number(health.samples) || 0;
        var midFailureRate = midSamples ? midFailures / midSamples : 0;

        if (
          midFailureRate >= 0.15 ||
          (Number.isFinite(midTtfb) && midTtfb >= config.threeWayTtfbMs)
        ) {
          return Math.min(config.maxPieces, 2);
        }

        return 1;
      }

      if (candidates.length > 1) {
        return Math.min(config.maxPieces, length >= 1024 * 1024 ? 3 : 2);
      }

      if (!health || Number(health.samples) < 2) {
        return Math.min(config.maxPieces, 2);
      }

      var failures = Number(health.failures) || 0;
      var samples = Number(health.samples) || 0;
      var failureRate = samples ? failures / samples : 0;
      var ttfb = Number(health.ewmaTtfbMs);
      var throughput = Number(health.ewmaThroughputBps);

      if (failureRate >= 0.15 || (Number.isFinite(ttfb) && ttfb >= config.threeWayTtfbMs)) {
        return Math.min(config.maxPieces, 3);
      }

      if (Number.isFinite(ttfb) && ttfb <= config.fastTtfbMs) {
        if (
          length < 1024 * 1024 ||
          (Number.isFinite(throughput) && throughput >= 8 * 1024 * 1024)
        ) {
          return 1;
        }
      }

      return Math.min(config.maxPieces, 2);
    }

    function trackStrategy(pieceCount) {
      if (pieceCount <= 1) {
        stats.adaptiveNative += 1;
      } else if (pieceCount === 2) {
        stats.adaptive2Way += 1;
      } else {
        stats.adaptive3Way += 1;
      }
    }

    async function fetchPiece(baseRequest, piece, operationSignal, ordinal) {
      var lastError = null;

      for (var attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        if (operationSignal && operationSignal.aborted) {
          throw createAbortError(operationSignal.reason);
        }

        if (attempt > 0) {
          stats.retries += 1;
          await sleep(Math.min(400, 80 * Math.pow(2, attempt - 1)), operationSignal);
        }

        try {
          return await semaphore.run(async function () {
            var timed = createTimedSignal(operationSignal, config.timeoutMs);
            var headers = new Headers(baseRequest.headers);
            headers.set("Range", core.formatRange(piece.start, piece.end));

            var selectedUrl = config.multiCdnEnabled
              ? resolver.pickCandidate(baseRequest.url, piece.length, ordinal)
              : baseRequest.url;

            var request = copyRequestWithUrl(baseRequest, selectedUrl, headers, timed.signal);
            var started = now();
            var headersAt = started;
            stats.subrequests += 1;
            resolver.beginRequest(selectedUrl);

            try {
              var response = await nativeFetch(request);
              headersAt = now();

              if (response.status !== 206) {
                throw new PieceHttpError(response.status);
              }

              var encoding = response.headers.get("content-encoding");
              if (encoding && encoding.toLowerCase() !== "identity") {
                throw new Error("Encoded Range response is not safe to reassemble");
              }

              var contentRange = core.parseContentRange(response.headers.get("content-range"));
              var bytes = new Uint8Array(await response.arrayBuffer());
              var ended = now();

              if (!core.validatePiece(piece, contentRange, bytes.byteLength)) {
                throw new Error("Sub-range validation failed");
              }

              resolver.observePlayableUrl(selectedUrl);
              resolver.recordResult(selectedUrl, {
                ok: true,
                ttfbMs: headersAt - started,
                durationMs: ended - started,
                bytes: bytes.byteLength
              });

              return {
                piece: piece,
                bytes: bytes,
                total: contentRange.total,
                headers: response.headers,
                statusText: response.statusText,
                type: response.type,
                redirected: response.redirected,
                etag: response.headers.get("etag"),
                lastModified: response.headers.get("last-modified"),
                sourceUrl: selectedUrl,
                sourceHost: new URL(selectedUrl).hostname,
                durationMs: ended - started
              };
            } catch (error) {
              if (!isAbortError(error)) {
                resolver.recordResult(selectedUrl, { ok: false });
              }
              throw error;
            } finally {
              resolver.endRequest(selectedUrl);
              timed.cleanup();
            }
          }, operationSignal);
        } catch (error) {
          lastError = error;
          if (
            (operationSignal && operationSignal.aborted) ||
            attempt >= config.maxRetries ||
            !shouldRetry(error)
          ) {
            if (operationSignal && operationSignal.aborted) {
              throw createAbortError(operationSignal.reason);
            }
            throw error;
          }
        }
      }

      throw lastError || new Error("Sub-range fetch failed");
    }

    function makeSyntheticResponse(baseRequest, requestedRange, pieces) {
      var totals = pieces
        .map(function (item) { return item.total; })
        .filter(function (value) { return value !== null; });

      if (totals.length !== pieces.length || new Set(totals).size !== 1) {
        throw new Error("Inconsistent media total length across sub-ranges");
      }

      var hosts = new Set(
        pieces.map(function (item) { return item.sourceHost; }).filter(Boolean)
      );

      if (hosts.size <= 1) {
        var etags = pieces.map(function (item) { return item.etag; }).filter(Boolean);
        if (new Set(etags).size > 1) {
          throw new Error("ETag changed across same-host sub-ranges");
        }

        var lastModified = pieces
          .map(function (item) { return item.lastModified; })
          .filter(Boolean);
        if (new Set(lastModified).size > 1) {
          throw new Error("Last-Modified changed across same-host sub-ranges");
        }
      }

      var body = core.concatUint8Arrays(
        pieces.map(function (item) { return item.bytes; }),
        requestedRange.length
      );

      var headers = new Headers(pieces[0].headers);
      headers.delete("content-encoding");
      headers.delete("transfer-encoding");
      headers.set(
        "content-range",
        "bytes " +
          String(requestedRange.start) +
          "-" +
          String(requestedRange.end) +
          "/" +
          String(totals[0])
      );
      headers.set("content-length", String(requestedRange.length));
      headers.set("accept-ranges", "bytes");

      var response = new Response(body, {
        status: 206,
        statusText: pieces[0].statusText || "Partial Content",
        headers: headers
      });

      [
        ["url", baseRequest.url],
        ["type", pieces[0].type],
        ["redirected", pieces[0].redirected]
      ].forEach(function (entry) {
        try {
          Object.defineProperty(response, entry[0], {
            configurable: true,
            value: entry[1]
          });
        } catch (_) {}
      });

      return response;
    }

    function makeCachedResponse(baseRequest, requestedRange, cached) {
      var headers = new Headers(cached.headers || {});
      headers.delete("content-encoding");
      headers.delete("transfer-encoding");
      headers.set(
        "content-range",
        "bytes " +
          String(requestedRange.start) +
          "-" +
          String(requestedRange.end) +
          "/" +
          String(cached.total)
      );
      headers.set("content-length", String(cached.bytes.byteLength));
      headers.set("accept-ranges", "bytes");

      var response = new Response(cached.bytes.slice(), {
        status: 206,
        statusText: cached.statusText || "Partial Content",
        headers: headers
      });

      try {
        Object.defineProperty(response, "url", {
          configurable: true,
          value: baseRequest.url
        });
      } catch (_) {}

      return response;
    }

    function observeIndexBody(baseRequest, requestedRange, response, startedAt) {
      if (requestedRange.length > 128 * 1024) {
        return;
      }

      try {
        var cloned = response.clone();
        cloned.arrayBuffer().then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          observeMediaIndex(baseRequest.url, requestedRange, bytes);
          if (startedAt !== undefined) {
            resolver.recordResult(baseRequest.url, {
              ok: true,
              durationMs: now() - startedAt,
              bytes: bytes.byteLength
            });
          }
          publish();
        }).catch(function () {});
      } catch (_) {}
    }

    function scheduleSegmentPrefetch(baseRequest, requestedRange) {
      if (!config.prefetchEnabled || config.prefetchSegments < 1) {
        return;
      }

      var key = resourceKey(baseRequest.url);
      var current = prefetch.matchSegment(key, requestedRange);
      if (!current) {
        return;
      }

      var generation = prefetch.noteDemand(key, current.index);
      prefetch.abortStale(key, current.index, config.prefetchSegments + 1);

      var upcoming = prefetch.nextSegments(key, current.index, config.prefetchSegments);
      upcoming.forEach(function (segment) {
        if (prefetch.has(key, segment)) {
          return;
        }

        if (prefetch.getInflight(key, segment)) {
          return;
        }

        setTimeout(function () {
          if (!prefetch.isGenerationCurrent(key, generation)) {
            return;
          }
          if (prefetch.getInflight(key, segment) || prefetch.has(key, segment)) {
            return;
          }

          var controller = new AbortController();

          var promise = (async function () {
            var selectedUrl = config.multiCdnEnabled
              ? resolver.pickCandidate(baseRequest.url, segment.length, segment.index)
              : baseRequest.url;
            var headers = new Headers(baseRequest.headers);
            headers.set("Range", core.formatRange(segment.start, segment.end));
            var request = copyRequestWithUrl(baseRequest, selectedUrl, headers, controller.signal);
            var started = now();
            var headersAt = started;
            resolver.beginRequest(selectedUrl);

            try {
              var response = await nativeFetch(request);
              headersAt = now();
              if (response.status !== 206) {
                throw new PieceHttpError(response.status);
              }

              var contentRange = core.parseContentRange(response.headers.get("content-range"));
              var bytes = new Uint8Array(await response.arrayBuffer());
              var ended = now();

              if (!core.validatePiece(segment, contentRange, bytes.byteLength)) {
                throw new Error("Prefetch range validation failed");
              }

              resolver.observePlayableUrl(selectedUrl);
              resolver.recordResult(selectedUrl, {
                ok: true,
                ttfbMs: headersAt - started,
                durationMs: ended - started,
                bytes: bytes.byteLength
              });

              var value = {
                bytes: bytes,
                headers: response.headers,
                statusText: response.statusText,
                total: contentRange.total
              };
              prefetch.put(key, segment, value);
              publish();
              return value;
            } catch (error) {
              if (!isAbortError(error)) {
                resolver.recordResult(selectedUrl, { ok: false });
              }
              throw error;
            } finally {
              resolver.endRequest(selectedUrl);
            }
          })();

          prefetch.setInflight(key, segment, promise, controller);
        }, config.prefetchDelayMs);
      });
    }

    async function maybeServePrefetch(baseRequest, requestedRange) {
      if (!config.prefetchEnabled) {
        return null;
      }

      var key = resourceKey(baseRequest.url);
      var cached = prefetch.take(key, requestedRange);
      if (cached) {
        stats.prefetchHits += 1;
        stats.prefetchBytesServed += cached.bytes.byteLength;
        scheduleSegmentPrefetch(baseRequest, requestedRange);
        publish();
        return makeCachedResponse(baseRequest, requestedRange, cached);
      }

      var inflight = prefetch.getInflight(key, requestedRange);
      if (!inflight) {
        return null;
      }

      stats.prefetchJoined += 1;

      var timedOut = false;
      var timer;
      try {
        var result = await Promise.race([
          inflight.promise,
          new Promise(function (resolve) {
            timer = setTimeout(function () {
              timedOut = true;
              resolve(null);
            }, config.prefetchWaitMs);
          })
        ]);

        if (timer) {
          clearTimeout(timer);
        }

        if (result) {
          var joined = prefetch.take(key, requestedRange);
          if (joined) {
            stats.prefetchHits += 1;
            stats.prefetchBytesServed += joined.bytes.byteLength;
            scheduleSegmentPrefetch(baseRequest, requestedRange);
            publish();
            return makeCachedResponse(baseRequest, requestedRange, joined);
          }
        }
      } catch (_) {
        if (timer) {
          clearTimeout(timer);
        }
      }

      if (timedOut) {
        try {
          inflight.controller.abort();
        } catch (_) {}
      }
      return null;
    }

    async function fetchNativeRange(baseRequest, requestedRange) {
      var started = now();
      resolver.beginRequest(baseRequest.url);
      try {
        var response = await nativeFetch(baseRequest);
        var headersAt = now();

        resolver.observePlayableUrl(baseRequest.url);
        resolver.recordResult(baseRequest.url, {
          ok: response.status === 206,
          ttfbMs: headersAt - started
        });

        if (response.status === 206) {
          observeIndexBody(baseRequest, requestedRange, response, started);
          scheduleSegmentPrefetch(baseRequest, requestedRange);
        }

        return response;
      } catch (error) {
        if (!isAbortError(error)) {
          resolver.recordResult(baseRequest.url, { ok: false });
        }
        throw error;
      } finally {
        resolver.endRequest(baseRequest.url);
      }
    }

    async function accelerateRange(baseRequest, requestedRange, pieceCount) {
      var pieces = core.splitRange(requestedRange.start, requestedRange.end, pieceCount);
      var safeUrl = core.sanitizeUrl(baseRequest.url);
      var started = now();
      var jobController = new AbortController();
      var onBaseAbort = null;

      if (baseRequest.signal) {
        onBaseAbort = function () {
          jobController.abort(baseRequest.signal.reason);
        };
        if (baseRequest.signal.aborted) {
          jobController.abort(baseRequest.signal.reason);
        } else {
          baseRequest.signal.addEventListener("abort", onBaseAbort, { once: true });
        }
      }

      try {
        var piecePromises = pieces.map(function (piece, index) {
          return fetchPiece(baseRequest, piece, jobController.signal, index).catch(function (error) {
            if (!jobController.signal.aborted) {
              jobController.abort(error);
            }
            throw error;
          });
        });

        var results;
        try {
          results = await Promise.all(piecePromises);
        } catch (error) {
          if (!jobController.signal.aborted) {
            jobController.abort(error);
          }
          await Promise.allSettled(piecePromises);
          throw error;
        }

        results.sort(function (a, b) {
          return a.piece.index - b.piece.index;
        });

        var response = makeSyntheticResponse(baseRequest, requestedRange, results);
        stats.accelerated += 1;
        stats.bytesAccelerated += requestedRange.length;
        stats.last = {
          result: "accelerated",
          host: safeUrl.host,
          path: safeUrl.path,
          rangeBytes: requestedRange.length,
          pieces: pieceCount,
          durationMs: Math.round((now() - started) * 10) / 10
        };

        scheduleSegmentPrefetch(baseRequest, requestedRange);
        publish();
        return response;
      } finally {
        if (baseRequest.signal && onBaseAbort) {
          baseRequest.signal.removeEventListener("abort", onBaseAbort);
        }
      }
    }

    async function acceleratedFetch(input, init) {
      stats.totalFetches += 1;

      var baseRequest;
      try {
        baseRequest = new Request(input, init);
      } catch (_) {
        return nativeFetch(input, init);
      }

      if (baseRequest.method !== "GET") {
        return nativeFetch(input, init);
      }

      if (isMetadataUrl(baseRequest.url)) {
        var metadataResponse = await nativeFetch(baseRequest);
        observeMetadataResponse(metadataResponse);
        return metadataResponse;
      }

      if (!config.enabled) {
        return nativeFetch(baseRequest);
      }

      var parsedUrl;
      try {
        parsedUrl = new URL(baseRequest.url);
      } catch (_) {
        return nativeFetch(baseRequest);
      }

      if (!core.isDouyinVodHost(parsedUrl.hostname)) {
        return nativeFetch(baseRequest);
      }

      var requestedRange = core.parseRangeHeader(baseRequest.headers.get("range"));
      if (!requestedRange) {
        return nativeFetch(baseRequest);
      }

      stats.matchedRangeFetches += 1;
      resolver.observePlayableUrl(baseRequest.url);
      touchActiveResource(resourceKey(baseRequest.url));

      if (config.multiCdnEnabled) {
        resolver.verifyAlternates(baseRequest.url).catch(function () {});
      }

      var prefetched = await maybeServePrefetch(baseRequest, requestedRange);
      if (prefetched) {
        return prefetched;
      }

      if (requestedRange.length > config.maxRangeBytes) {
        stats.bypassedLarge += 1;
        trackStrategy(1);
        return fetchNativeRange(baseRequest, requestedRange);
      }

      var pieceCount = chooseAdaptivePieceCount(baseRequest.url, requestedRange.length);
      trackStrategy(pieceCount);

      if (pieceCount < 2) {
        if (requestedRange.length < config.minSplitBytes) {
          stats.bypassedSmall += 1;
        }
        return fetchNativeRange(baseRequest, requestedRange);
      }

      try {
        debugLog(
          "adaptive",
          parsedUrl.hostname,
          parsedUrl.pathname,
          requestedRange.length,
          "bytes",
          pieceCount,
          "pieces"
        );
        return await accelerateRange(baseRequest, requestedRange, pieceCount);
      } catch (error) {
        if (baseRequest.signal && baseRequest.signal.aborted) {
          stats.failures += 1;
          stats.last = {
            result: "aborted",
            host: parsedUrl.hostname,
            path: parsedUrl.pathname,
            rangeBytes: requestedRange.length,
            pieces: pieceCount
          };
          publish();
          throw createAbortError(baseRequest.signal.reason);
        }

        stats.fallbacks += 1;
        stats.last = {
          result: "fallback",
          host: parsedUrl.hostname,
          path: parsedUrl.pathname,
          rangeBytes: requestedRange.length,
          pieces: pieceCount,
          error: error && error.name ? error.name : "Error"
        };
        publish();
        debugLog("fallback to native fetch", stats.last);
        return fetchNativeRange(baseRequest, requestedRange);
      }
    }

    return {
      fetch: acceleratedFetch,
      observeMetadata: observeMetadata,
      isMetadataUrl: isMetadataUrl,
      observeMediaIndex: observeMediaIndex,
      updateConfig: function (nextConfig) {
        config = normalizeConfig(Object.assign({}, config, nextConfig || {}));
        semaphore.setLimit(config.globalConcurrency);
        publish();
        return Object.assign({}, config);
      },
      getConfig: function () {
        return Object.assign({}, config);
      },
      getStats: getStatsSnapshot,
      resetStats: function () {
        stats.totalFetches = 0;
        stats.metadataObserved = 0;
        stats.mediaIndexesObserved = 0;
        stats.matchedRangeFetches = 0;
        stats.accelerated = 0;
        stats.adaptiveNative = 0;
        stats.adaptive2Way = 0;
        stats.adaptive3Way = 0;
        stats.fallbacks = 0;
        stats.failures = 0;
        stats.bypassedSmall = 0;
        stats.bypassedLarge = 0;
        stats.subrequests = 0;
        stats.retries = 0;
        stats.bytesAccelerated = 0;
        stats.prefetchHits = 0;
        stats.prefetchJoined = 0;
        stats.prefetchBytesServed = 0;
        stats.last = null;
        publish();
      },
      clearCaches: function () {
        activeResources.clear();
        prefetch.clear();
        publish();
      }
    };
  }

  return Object.freeze({
    VERSION: VERSION,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    normalizeConfig: normalizeConfig,
    createFetchAccelerator: createFetchAccelerator
  });
});
