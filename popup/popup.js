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

var fields = {
  enabled: document.getElementById("enabled"),
  adaptiveConcurrency: document.getElementById("adaptiveConcurrency"),
  multiCdnEnabled: document.getElementById("multiCdnEnabled"),
  prefetchEnabled: document.getElementById("prefetchEnabled"),
  prefetchSegments: document.getElementById("prefetchSegments"),
  minSplitKiB: document.getElementById("minSplitKiB"),
  targetChunkKiB: document.getElementById("targetChunkKiB"),
  maxPieces: document.getElementById("maxPieces"),
  globalConcurrency: document.getElementById("globalConcurrency"),
  timeoutMs: document.getElementById("timeoutMs"),
  maxRetries: document.getElementById("maxRetries"),
  debug: document.getElementById("debug")
};

var saveTimer = null;

function formatBytes(value) {
  var bytes = Number(value) || 0;
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / 1024 / 1024).toFixed(2) + " MiB";
}

async function loadConfig() {
  var config = await chrome.storage.local.get(DEFAULT_CONFIG);
  fields.enabled.checked = config.enabled !== false;
  fields.adaptiveConcurrency.checked = config.adaptiveConcurrency !== false;
  fields.multiCdnEnabled.checked = config.multiCdnEnabled !== false;
  fields.prefetchEnabled.checked = config.prefetchEnabled !== false;
  fields.prefetchSegments.value = config.prefetchSegments;
  fields.minSplitKiB.value = Math.round(config.minSplitBytes / 1024);
  fields.targetChunkKiB.value = Math.round(config.targetChunkBytes / 1024);
  fields.maxPieces.value = config.maxPieces;
  fields.globalConcurrency.value = config.globalConcurrency;
  fields.timeoutMs.value = config.timeoutMs;
  fields.maxRetries.value = config.maxRetries;
  fields.debug.checked = config.debug === true;
}

function collectConfig() {
  return {
    enabled: fields.enabled.checked,
    adaptiveConcurrency: fields.adaptiveConcurrency.checked,
    multiCdnEnabled: fields.multiCdnEnabled.checked,
    prefetchEnabled: fields.prefetchEnabled.checked,
    prefetchSegments: Math.max(0, Math.min(2, Number(fields.prefetchSegments.value) || 0)),
    prefetchWaitMs: DEFAULT_CONFIG.prefetchWaitMs,
    prefetchDelayMs: DEFAULT_CONFIG.prefetchDelayMs,
    prefetchCacheBytes: DEFAULT_CONFIG.prefetchCacheBytes,
    minSplitBytes: Math.max(64, Number(fields.minSplitKiB.value) || 512) * 1024,
    slowMinSplitBytes: DEFAULT_CONFIG.slowMinSplitBytes,
    targetChunkBytes: Math.max(64, Number(fields.targetChunkKiB.value) || 256) * 1024,
    maxPieces: Math.max(1, Math.min(3, Number(fields.maxPieces.value) || 3)),
    globalConcurrency: Number(fields.globalConcurrency.value) || 6,
    timeoutMs: Number(fields.timeoutMs.value) || 8000,
    maxRetries: Number(fields.maxRetries.value) || 0,
    maxRangeBytes: DEFAULT_CONFIG.maxRangeBytes,
    fastTtfbMs: DEFAULT_CONFIG.fastTtfbMs,
    threeWayTtfbMs: DEFAULT_CONFIG.threeWayTtfbMs,
    debug: fields.debug.checked
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  document.getElementById("saveState").textContent = "保存中...";
  saveTimer = setTimeout(async function () {
    await chrome.storage.local.set(collectConfig());
    document.getElementById("saveState").textContent = "已保存";
    setTimeout(function () {
      document.getElementById("saveState").textContent = "设置自动保存";
    }, 900);
  }, 180);
}

Object.values(fields).forEach(function (element) {
  element.addEventListener("change", scheduleSave);
  element.addEventListener("input", function () {
    if (element.type === "number") {
      scheduleSave();
    }
  });
});

async function activeTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function renderStats(record) {
  var dot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");

  if (!record || !record.stats) {
    dot.classList.remove("ok");
    statusText.textContent = "等待抖音页面...";
    return;
  }

  var stats = record.stats;
  var resolver = stats.resolver || {};
  var resolverStats = resolver.stats || {};
  var prefetch = stats.prefetch || {};
  var prefetchStats = prefetch.stats || {};

  dot.classList.add("ok");
  statusText.textContent = "运行中 · v" + String(stats.version || "0.2.3");
  document.getElementById("matched").textContent = String(stats.matchedRangeFetches || 0);
  document.getElementById("accelerated").textContent = String(stats.accelerated || 0);
  document.getElementById("strategies").textContent =
    String(stats.adaptiveNative || 0) + " / " +
    String(stats.adaptive2Way || 0) + " / " +
    String(stats.adaptive3Way || 0);
  document.getElementById("candidates").textContent =
    String(resolverStats.candidateUrls || 0) + " / " +
    String(resolverStats.distinctCandidateHosts || 0);
  document.getElementById("verifiedCdn").textContent =
    String(resolverStats.verifiedAlternates || 0);
  document.getElementById("prefetchHits").textContent =
    String(stats.prefetchHits || 0);
  document.getElementById("sidxIndexes").textContent =
    String(prefetchStats.indexesParsed || 0) + " / " +
    String(stats.mediaIndexesObserved || 0);
  document.getElementById("prefetchCache").textContent =
    formatBytes(prefetchStats.cachedBytes || 0);
  document.getElementById("fallbacks").textContent = String(stats.fallbacks || 0);
  document.getElementById("subrequests").textContent = String(stats.subrequests || 0);
  document.getElementById("bytes").textContent = formatBytes(stats.bytesAccelerated || 0);

  if (!stats.last) {
    document.getElementById("last").textContent = "暂无媒体请求";
    return;
  }

  var last = stats.last;
  var text = String(last.result || "") + " · " + String(last.rangeBytes || 0) + " B";
  if (last.pieces) text += " · " + String(last.pieces) + " 片";
  if (last.durationMs !== undefined) text += " · " + String(last.durationMs) + " ms";
  if (last.path) text += "\n" + String(last.path);
  document.getElementById("last").textContent = text;
}

async function refreshStats() {
  try {
    var tab = await activeTab();
    if (!tab || typeof tab.id !== "number") {
      renderStats(null);
      return;
    }
    var key = "dtrStats:" + String(tab.id);
    var value = await chrome.storage.session.get(key);
    renderStats(value[key] || null);
  } catch (_) {
    renderStats(null);
  }
}

async function sendToActiveTab(type) {
  try {
    var tab = await activeTab();
    if (tab && typeof tab.id === "number") {
      await chrome.tabs.sendMessage(tab.id, { type: type });
      return tab.id;
    }
  } catch (_) {}
  return null;
}

document.getElementById("resetStats").addEventListener("click", async function () {
  var tabId = await sendToActiveTab("DTR_RESET_STATS");
  if (tabId !== null) {
    await chrome.storage.session.remove("dtrStats:" + String(tabId));
  }
  renderStats(null);
});

document.getElementById("clearCaches").addEventListener("click", function () {
  sendToActiveTab("DTR_CLEAR_CACHES");
});

loadConfig().catch(function () {});
refreshStats();
setInterval(refreshStats, 750);
