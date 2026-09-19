"use strict";

function sanitizeRecord(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeRecord);
  }

  var out = {};
  Object.keys(value).forEach(function (key) {
    if (/cookie|signature|token|webid|fid|query/i.test(key)) {
      return;
    }
    out[key] = sanitizeRecord(value[key]);
  });
  return out;
}

(async function () {
  var session = await chrome.storage.session.get(null);
  var entries = Object.keys(session)
    .filter(function (key) { return key.indexOf("dtrStats:") === 0; })
    .map(function (key) { return session[key]; })
    .sort(function (a, b) {
      return Number(b && b.receivedAt || 0) - Number(a && a.receivedAt || 0);
    });

  document.getElementById("out").textContent = JSON.stringify({
    version: chrome.runtime.getManifest().version,
    generatedAt: Date.now(),
    latest: sanitizeRecord(entries[0] || null),
    records: entries.length
  }, null, 2);
})().catch(function (error) {
  document.getElementById("out").textContent = JSON.stringify({
    error: error && error.message ? error.message : String(error)
  }, null, 2);
});
