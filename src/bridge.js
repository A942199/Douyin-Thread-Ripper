(function () {
  "use strict";

  var DEFAULT_CONFIG = {
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
  };

  var pendingStats = null;
  var statsTimer = null;

  async function pushConfig() {
    try {
      var config = await chrome.storage.local.get(DEFAULT_CONFIG);
      window.postMessage({
        source: "DTR_EXTENSION",
        type: "DTR_CONFIG",
        config: config
      }, "*");
    } catch (_) {}
  }

  function flushStats() {
    statsTimer = null;
    if (!pendingStats) {
      return;
    }

    var stats = pendingStats;
    pendingStats = null;

    try {
      chrome.runtime.sendMessage({
        type: "DTR_STATS",
        stats: stats
      }).catch(function () {});
    } catch (_) {}
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.source !== "DTR_PAGE") {
      return;
    }

    if (event.data.type === "DTR_READY") {
      pushConfig();
      return;
    }

    if (event.data.type === "DTR_STATS" && event.data.stats) {
      pendingStats = event.data.stats;
      if (!statsTimer) {
        statsTimer = setTimeout(flushStats, 350);
      }
    }
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    var touchesConfig = Object.keys(DEFAULT_CONFIG).some(function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    });

    if (touchesConfig) {
      pushConfig();
    }
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message) {
      return;
    }

    if (message.type === "DTR_RESET_STATS") {
      window.postMessage({
        source: "DTR_EXTENSION",
        type: "DTR_RESET_STATS"
      }, "*");
      return;
    }

    if (message.type === "DTR_CLEAR_CACHES") {
      window.postMessage({
        source: "DTR_EXTENSION",
        type: "DTR_CLEAR_CACHES"
      }, "*");
      return;
    }

    if (message.type === "DTR_PUSH_CONFIG") {
      pushConfig();
    }
  });

  pushConfig();
})();
