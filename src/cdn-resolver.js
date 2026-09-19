(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    try {
      Object.defineProperty(root, "DTRCdnResolver", {
        configurable: true,
        value: api
      });
    } catch (_) {
      root.DTRCdnResolver = api;
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CONTEXT_QUERY_KEYS = ["fid", "webid"];

  function isDouyinVodHost(hostname) {
    if (typeof hostname !== "string") {
      return false;
    }
    var host = hostname.toLowerCase();
    return host === "douyinvod.com" || host.endsWith(".douyinvod.com");
  }

  function safeUrl(value) {
    try {
      return new URL(value);
    } catch (_) {
      return null;
    }
  }

  function equalBytes(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) {
      return false;
    }
    for (var i = 0; i < a.byteLength; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function parseContentRangeTotal(value) {
    if (typeof value !== "string") {
      return null;
    }
    var match = /^\s*bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(value);
    if (!match) {
      return null;
    }
    var total = Number(match[1]);
    return Number.isSafeInteger(total) ? total : null;
  }

  function ewma(previous, next, alpha) {
    if (!Number.isFinite(next)) {
      return previous;
    }
    if (!Number.isFinite(previous)) {
      return next;
    }
    return previous * (1 - alpha) + next * alpha;
  }

  function createResolver(options) {
    var opts = options || {};
    var nativeFetch = typeof opts.nativeFetch === "function" ? opts.nativeFetch : null;
    var probeBytes = Math.max(256, Math.min(4096, Number(opts.probeBytes) || 1024));
    var probeTimeoutMs = Math.max(1000, Math.min(15000, Number(opts.probeTimeoutMs) || 5000));
    var rejectCooldownMs = Math.max(5000, Math.min(300000, Number(opts.rejectCooldownMs) || 60000));

    var groups = new Map();
    var pathToGroups = new Map();
    var health = new Map();
    var validations = new Map();

    var stats = {
      metadataGroups: 0,
      candidateUrls: 0,
      distinctCandidateHosts: 0,
      probes: 0,
      verifiedAlternates: 0,
      rejectedAlternates: 0,
      selections: 0,
      multiHostSelections: 0
    };

    function groupKey(urls, container, sourceKey) {
      if (container && typeof container.url_key === "string" && container.url_key) {
        return "url_key:" + container.url_key;
      }
      if (container && typeof container.urlKey === "string" && container.urlKey) {
        return "url_key:" + container.urlKey;
      }
      if (container && typeof container.file_id === "string" && container.file_id) {
        return "file_id:" + container.file_id;
      }
      if (container && typeof container.fileId === "string" && container.fileId) {
        return "file_id:" + container.fileId;
      }

      // React hydration currently exposes top-level playAddr/playAddrH265
      // arrays on the video object. video.uri is shared across representations,
      // so the field name must be part of the identity.
      if (
        container &&
        typeof container.uri === "string" &&
        container.uri &&
        typeof sourceKey === "string" &&
        sourceKey
      ) {
        return "uri_field:" + container.uri + ":" + sourceKey;
      }

      // Douyin reuses video.uri across many different bitrate/codec
      // representations of the same aweme. A bare uri is therefore not a
      // safe CDN identity. Fall back to the concrete representation path.
      var first = urls.map(safeUrl).find(Boolean);
      return first ? "path:" + first.pathname : null;
    }

    function addPathMapping(path, key) {
      var set = pathToGroups.get(path);
      if (!set) {
        set = new Set();
        pathToGroups.set(path, set);
      }
      set.add(key);
    }

    function rawCandidateUrl(value) {
      if (typeof value === "string") {
        return value;
      }
      if (value && typeof value === "object" && typeof value.src === "string") {
        return value.src;
      }
      return null;
    }

    function registerUrls(urls, container, sourceKey) {
      var filtered = [];
      var seen = new Set();

      (urls || []).forEach(function (value) {
        var raw = rawCandidateUrl(value);
        if (!raw || seen.has(raw)) {
          return;
        }
        var url = safeUrl(raw);
        if (!url || url.protocol !== "https:" || !isDouyinVodHost(url.hostname)) {
          return;
        }
        seen.add(raw);
        filtered.push(raw);
      });

      if (!filtered.length) {
        return;
      }

      var key = groupKey(filtered, container || {}, sourceKey);
      if (!key) {
        return;
      }

      var group = groups.get(key);
      if (!group) {
        group = {
          key: key,
          candidates: new Map()
        };
        groups.set(key, group);
      }

      filtered.forEach(function (value) {
        var parsed = safeUrl(value);
        if (!group.candidates.has(value)) {
          group.candidates.set(value, {
            rawUrl: value,
            host: parsed.hostname,
            path: parsed.pathname
          });
        }
        addPathMapping(parsed.pathname, key);
      });
    }

    function observeMetadata(payload) {
      var visited = new WeakSet();

      function walk(value) {
        if (!value || typeof value !== "object") {
          return;
        }
        if (visited.has(value)) {
          return;
        }
        visited.add(value);

        if (!Array.isArray(value) && Array.isArray(value.url_list)) {
          registerUrls(value.url_list, value, "url_list");
        }
        if (!Array.isArray(value) && Array.isArray(value.urlList)) {
          registerUrls(value.urlList, value, "urlList");
        }

        // Current Douyin React hydration uses arrays of { src } objects
        // rather than play_addr.url_list.
        if (!Array.isArray(value) && Array.isArray(value.playAddr)) {
          registerUrls(value.playAddr, value, "playAddr");
        }
        if (!Array.isArray(value) && Array.isArray(value.playAddrH265)) {
          registerUrls(value.playAddrH265, value, "playAddrH265");
        }
        if (!Array.isArray(value) && Array.isArray(value.play_addr)) {
          registerUrls(value.play_addr, value, "play_addr");
        }
        if (!Array.isArray(value) && Array.isArray(value.play_addr_h265)) {
          registerUrls(value.play_addr_h265, value, "play_addr_h265");
        }

        if (Array.isArray(value)) {
          value.forEach(walk);
        } else {
          Object.keys(value).forEach(function (key) {
            walk(value[key]);
          });
        }
      }

      walk(payload);
      recomputeStats();
    }

    function recomputeStats() {
      var urls = new Set();
      var hosts = new Set();
      groups.forEach(function (group) {
        group.candidates.forEach(function (candidate) {
          urls.add(candidate.rawUrl);
          hosts.add(candidate.host);
        });
      });
      stats.metadataGroups = groups.size;
      stats.candidateUrls = urls.size;
      stats.distinctCandidateHosts = hosts.size;
    }

    function hydrate(rawUrl, primaryUrl) {
      var candidate = safeUrl(rawUrl);
      var primary = safeUrl(primaryUrl);
      if (!candidate || !primary || !isDouyinVodHost(candidate.hostname)) {
        return null;
      }

      CONTEXT_QUERY_KEYS.forEach(function (key) {
        if (!candidate.searchParams.has(key) && primary.searchParams.has(key)) {
          candidate.searchParams.set(key, primary.searchParams.get(key));
        }
      });

      return candidate.href;
    }

    function matchingGroup(primaryUrl) {
      var primary = safeUrl(primaryUrl);
      if (!primary) {
        return null;
      }
      var keys = pathToGroups.get(primary.pathname);
      if (!keys || !keys.size) {
        return null;
      }

      var best = null;
      keys.forEach(function (key) {
        var group = groups.get(key);
        if (!group) {
          return;
        }
        if (!best || group.candidates.size > best.candidates.size) {
          best = group;
        }
      });
      return best;
    }

    function observePlayableUrl(primaryUrl) {
      var primary = safeUrl(primaryUrl);
      if (!primary || !isDouyinVodHost(primary.hostname)) {
        return;
      }
      validations.set(primary.href, {
        status: "verified",
        checkedAt: Date.now(),
        primary: true
      });
      if (!health.has(primary.hostname)) {
        health.set(primary.hostname, {
          samples: 0,
          successes: 0,
          failures: 0,
          ewmaTtfbMs: NaN,
          ewmaThroughputBps: NaN,
          inflight: 0,
          lastFailureAt: 0
        });
      }
    }

    function getCandidates(primaryUrl, verifiedOnly) {
      var primary = safeUrl(primaryUrl);
      if (!primary) {
        return [];
      }

      var values = [primary.href];
      var group = matchingGroup(primary.href);

      if (group) {
        group.candidates.forEach(function (candidate) {
          var hydrated = hydrate(candidate.rawUrl, primary.href);
          if (hydrated) {
            values.push(hydrated);
          }
        });
      }

      var seenUrls = new Set();
      var seenHosts = new Set();

      return values.filter(function (value) {
        if (seenUrls.has(value)) {
          return false;
        }
        seenUrls.add(value);

        var parsed = safeUrl(value);
        if (!parsed) {
          return false;
        }

        if (value === primary.href) {
          seenHosts.add(parsed.hostname);
          return true;
        }

        if (seenHosts.has(parsed.hostname)) {
          return false;
        }

        if (verifiedOnly) {
          var state = validations.get(value);
          if (!state || state.status !== "verified") {
            return false;
          }
        }

        seenHosts.add(parsed.hostname);
        return true;
      });
    }

    async function probe(url, start, signal) {
      var offset = Math.max(0, Number(start) || 0);
      var controller = new AbortController();
      var timer = null;
      var onAbort = null;

      if (signal) {
        onAbort = function () {
          controller.abort(signal.reason);
        };
        if (signal.aborted) {
          controller.abort(signal.reason);
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      timer = setTimeout(function () {
        var error = new Error("CDN candidate probe timed out");
        error.name = "TimeoutError";
        controller.abort(error);
      }, probeTimeoutMs);

      var request = new Request(url, {
        method: "GET",
        headers: {
          Range: "bytes=" + String(offset) + "-" + String(offset + probeBytes - 1)
        },
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal
      });

      var started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

      try {
        var response = await nativeFetch(request);
        var headersAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

        if (response.status !== 206) {
          throw new Error("Candidate probe returned " + String(response.status));
        }

        var body = new Uint8Array(await response.arrayBuffer());
        var ended = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        var total = parseContentRangeTotal(response.headers.get("content-range"));
        var expectedLength = total === null
          ? probeBytes
          : Math.max(0, Math.min(probeBytes, total - offset));

        if (!body.byteLength || body.byteLength !== expectedLength) {
          throw new Error("Candidate probe returned unexpected byte length");
        }

        return {
          bytes: body,
          total: total,
          etag: response.headers.get("etag"),
          ttfbMs: headersAt - started,
          durationMs: ended - started
        };
      } finally {
        clearTimeout(timer);
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    }

    async function verifyAlternate(primaryUrl, candidateUrl, signal) {
      if (!nativeFetch || primaryUrl === candidateUrl) {
        return true;
      }

      var existing = validations.get(candidateUrl);
      if (existing && existing.status === "verified") {
        return true;
      }
      if (existing && existing.status === "rejected") {
        if (Date.now() - Number(existing.checkedAt || 0) < rejectCooldownMs) {
          return false;
        }
        validations.delete(candidateUrl);
        existing = null;
      }
      if (existing && existing.promise) {
        return existing.promise;
      }

      var promise = (async function () {
        stats.probes += 1;
        try {
          var headResults = await Promise.all([
            probe(primaryUrl, 0, signal),
            probe(candidateUrl, 0, signal)
          ]);
          var a = headResults[0];
          var b = headResults[1];
          var sameTotal = a.total !== null && b.total !== null && a.total === b.total;
          var sameEtag = !a.etag || !b.etag || a.etag === b.etag;
          var sameBytes = equalBytes(a.bytes, b.bytes);

          if (!sameTotal || !sameEtag || !sameBytes) {
            throw new Error("Candidate head bytes do not match primary");
          }

          var total = a.total;
          var offsets = [
            Math.max(0, Math.floor(total / 2 - probeBytes / 2)),
            Math.max(0, total - probeBytes)
          ].filter(function (value, index, list) {
            return value > 0 && list.indexOf(value) === index;
          });

          for (var i = 0; i < offsets.length; i += 1) {
            var pair = await Promise.all([
              probe(primaryUrl, offsets[i], signal),
              probe(candidateUrl, offsets[i], signal)
            ]);

            if (
              pair[0].total !== total ||
              pair[1].total !== total ||
              !equalBytes(pair[0].bytes, pair[1].bytes)
            ) {
              throw new Error("Candidate sampled bytes do not match primary");
            }
          }

          validations.set(candidateUrl, {
            status: "verified",
            checkedAt: Date.now(),
            primary: false
          });
          stats.verifiedAlternates += 1;
          recordResult(candidateUrl, {
            ok: true,
            ttfbMs: b.ttfbMs,
            durationMs: b.durationMs,
            bytes: b.bytes.byteLength
          });
          return true;
        } catch (_) {
          validations.set(candidateUrl, {
            status: "rejected",
            checkedAt: Date.now(),
            primary: false
          });
          stats.rejectedAlternates += 1;
          recordResult(candidateUrl, { ok: false });
          return false;
        }
      })();

      validations.set(candidateUrl, {
        status: "pending",
        checkedAt: Date.now(),
        promise: promise
      });

      return promise;
    }

    function verifyAlternates(primaryUrl, signal) {
      var all = getCandidates(primaryUrl, false);
      return Promise.allSettled(
        all
          .filter(function (value) { return value !== primaryUrl; })
          .map(function (value) {
            return verifyAlternate(primaryUrl, value, signal);
          })
      );
    }

    function recordResult(urlValue, result) {
      var url = safeUrl(urlValue);
      if (!url) {
        return;
      }

      var state = health.get(url.hostname) || {
        samples: 0,
        successes: 0,
        failures: 0,
        ewmaTtfbMs: NaN,
        ewmaThroughputBps: NaN,
        inflight: 0,
        lastFailureAt: 0
      };

      state.samples = (Number(state.samples) || 0) + 1;
      state.successes = Number(state.successes) || 0;
      state.failures = Number(state.failures) || 0;
      state.inflight = Number(state.inflight) || 0;
      state.lastFailureAt = Number(state.lastFailureAt) || 0;

      if (result && result.ok) {
        state.successes += 1;
        state.ewmaTtfbMs = ewma(state.ewmaTtfbMs, Number(result.ttfbMs), 0.25);

        if (
          Number(result.bytes) > 0 &&
          Number(result.durationMs) > 0
        ) {
          state.ewmaThroughputBps = ewma(
            state.ewmaThroughputBps,
            Number(result.bytes) / (Number(result.durationMs) / 1000),
            0.25
          );
        }
      } else {
        state.failures += 1;
        state.lastFailureAt = Date.now();
      }

      health.set(url.hostname, state);
    }

    function beginRequest(urlValue) {
      var url = safeUrl(urlValue);
      if (!url) {
        return;
      }
      var state = health.get(url.hostname) || {
        samples: 0,
        successes: 0,
        failures: 0,
        ewmaTtfbMs: NaN,
        ewmaThroughputBps: NaN,
        inflight: 0,
        lastFailureAt: 0
      };
      state.inflight += 1;
      health.set(url.hostname, state);
    }

    function endRequest(urlValue) {
      var url = safeUrl(urlValue);
      if (!url) {
        return;
      }
      var state = health.get(url.hostname);
      if (state) {
        state.inflight = Math.max(0, (Number(state.inflight) || 0) - 1);
      }
    }

    function scoreCandidate(urlValue, expectedBytes) {
      var url = safeUrl(urlValue);
      if (!url) {
        return Number.POSITIVE_INFINITY;
      }

      var state = health.get(url.hostname) || {};
      var ttfb = Number.isFinite(state.ewmaTtfbMs) ? state.ewmaTtfbMs : 120;
      var throughput = Number.isFinite(state.ewmaThroughputBps) && state.ewmaThroughputBps > 0
        ? state.ewmaThroughputBps
        : 4 * 1024 * 1024;
      var transferMs = Math.max(0, Number(expectedBytes) || 0) / throughput * 1000;
      var samples = Number(state.samples) || 0;
      var failures = Number(state.failures) || 0;
      var failureRate = samples ? failures / samples : 0;
      var recentFailurePenalty =
        state.lastFailureAt && Date.now() - state.lastFailureAt < 30000 ? 400 : 0;
      var inflightPenalty = (Number(state.inflight) || 0) * 35;

      return ttfb + transferMs + failureRate * 1200 + recentFailurePenalty + inflightPenalty;
    }

    function pickCandidate(primaryUrl, expectedBytes, ordinal) {
      var candidates = getCandidates(primaryUrl, true);
      if (!candidates.length) {
        return primaryUrl;
      }

      var ranked = candidates
        .map(function (value) {
          return {
            url: value,
            score: scoreCandidate(value, expectedBytes)
          };
        })
        .sort(function (a, b) {
          return a.score - b.score;
        });

      stats.selections += 1;

      var topCount = Math.min(2, ranked.length);
      var selected = ranked[(Number(ordinal) || 0) % topCount].url;

      var selectedHost = safeUrl(selected).hostname;
      var primaryHost = safeUrl(primaryUrl).hostname;
      if (selectedHost !== primaryHost) {
        stats.multiHostSelections += 1;
      }

      return selected;
    }

    function getPrimaryHealth(primaryUrl) {
      var url = safeUrl(primaryUrl);
      if (!url) {
        return null;
      }
      var state = health.get(url.hostname);
      return state ? Object.assign({}, state) : null;
    }

    function snapshot() {
      var hostHealth = {};
      health.forEach(function (state, host) {
        hostHealth[host] = {
          samples: state.samples || 0,
          successes: state.successes || 0,
          failures: state.failures || 0,
          ewmaTtfbMs: Number.isFinite(state.ewmaTtfbMs)
            ? Math.round(state.ewmaTtfbMs * 10) / 10
            : null,
          ewmaThroughputMbps: Number.isFinite(state.ewmaThroughputBps)
            ? Math.round(state.ewmaThroughputBps * 8 / 100000) / 10
            : null,
          inflight: state.inflight || 0
        };
      });

      return {
        stats: Object.assign({}, stats),
        hosts: hostHealth
      };
    }

    return {
      observeMetadata: observeMetadata,
      observePlayableUrl: observePlayableUrl,
      getCandidates: getCandidates,
      verifyAlternates: verifyAlternates,
      pickCandidate: pickCandidate,
      recordResult: recordResult,
      beginRequest: beginRequest,
      endRequest: endRequest,
      getPrimaryHealth: getPrimaryHealth,
      snapshot: snapshot
    };
  }

  return Object.freeze({
    createResolver: createResolver
  });
});
