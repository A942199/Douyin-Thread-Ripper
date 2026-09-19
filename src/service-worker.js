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

chrome.runtime.onInstalled.addListener(async function () {
  try {
    var existing = await chrome.storage.local.get(null);
    var missing = {};

    Object.keys(DEFAULT_CONFIG).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(existing, key)) {
        missing[key] = DEFAULT_CONFIG[key];
      }
    });

    if (Object.keys(missing).length > 0) {
      await chrome.storage.local.set(missing);
    }
  } catch (_) {}
});

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message || message.type !== "DTR_STATS" || !message.stats) {
    return;
  }

  if (!sender.tab || typeof sender.tab.id !== "number") {
    return;
  }

  var key = "dtrStats:" + String(sender.tab.id);
  var value = {
    tabId: sender.tab.id,
    receivedAt: Date.now(),
    stats: message.stats
  };

  chrome.storage.session.set({
    [key]: value
  }).catch(function () {});
});
