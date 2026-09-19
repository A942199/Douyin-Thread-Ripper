(function () {
  "use strict";

  if (window.__DTR_INSTALLED__) {
    return;
  }

  if (!window.DTRFetchAccelerator || !window.DTRRangeCore) {
    return;
  }

  var nativeFetch = window.fetch.bind(window);
  var xhrPrototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  var nativeXhrOpen = xhrPrototype && xhrPrototype.open;
  var nativeXhrSend = xhrPrototype && xhrPrototype.send;
  var nativeXhrSetRequestHeader =
    xhrPrototype && xhrPrototype.setRequestHeader;

  var accelerator = window.DTRFetchAccelerator.createFetchAccelerator({
    nativeFetch: nativeFetch,
    config: window.DTRFetchAccelerator.DEFAULT_CONFIG,
    onStats: function (stats) {
      window.postMessage({
        source: "DTR_PAGE",
        type: "DTR_STATS",
        stats: stats
      }, "*");
    }
  });

  function wrappedFetch(input, init) {
    return accelerator.fetch(input, init);
  }

  try {
    Object.defineProperty(wrappedFetch, "name", {
      configurable: true,
      value: "fetch"
    });
  } catch (_) {}

  window.fetch = wrappedFetch;

  function absoluteUrl(value) {
    try {
      return new URL(String(value), location.href).href;
    } catch (_) {
      return "";
    }
  }

  function isDouyinVodUrl(value) {
    try {
      return window.DTRRangeCore.isDouyinVodHost(new URL(value).hostname);
    } catch (_) {
      return false;
    }
  }

  function observeMediaXhrIndex(xhr, requestUrl) {
    try {
      if (xhr.status !== 206 || !xhr.__dtrRangeHeader) {
        return;
      }

      var range = window.DTRRangeCore.parseRangeHeader(
        xhr.__dtrRangeHeader
      );

      if (
        !range ||
        range.length > 128 * 1024
      ) {
        return;
      }

      var finalUrl = xhr.responseURL || requestUrl;
      if (!isDouyinVodUrl(finalUrl)) {
        return;
      }

      if (
        xhr.responseType === "arraybuffer" &&
        xhr.response instanceof ArrayBuffer
      ) {
        accelerator.observeMediaIndex(
          finalUrl,
          xhr.__dtrRangeHeader,
          new Uint8Array(xhr.response)
        );
        return;
      }

      if (
        xhr.responseType === "blob" &&
        xhr.response &&
        typeof xhr.response.arrayBuffer === "function"
      ) {
        xhr.response.arrayBuffer().then(function (buffer) {
          accelerator.observeMediaIndex(
            finalUrl,
            xhr.__dtrRangeHeader,
            new Uint8Array(buffer)
          );
        }).catch(function () {});
      }
    } catch (_) {
      // Media XHR observation is best effort only.
    }
  }

  if (xhrPrototype && nativeXhrOpen && nativeXhrSend) {
    xhrPrototype.open = function () {
      try {
        this.__dtrRequestUrl = absoluteUrl(arguments[1]);
        this.__dtrRangeHeader = "";
      } catch (_) {
        this.__dtrRequestUrl = "";
        this.__dtrRangeHeader = "";
      }
      return nativeXhrOpen.apply(this, arguments);
    };

    if (nativeXhrSetRequestHeader) {
      xhrPrototype.setRequestHeader = function (name, value) {
        try {
          if (String(name).toLowerCase() === "range") {
            this.__dtrRangeHeader = String(value);
          }
        } catch (_) {}
        return nativeXhrSetRequestHeader.apply(this, arguments);
      };
    }

    xhrPrototype.send = function () {
      var xhr = this;
      var url = xhr.__dtrRequestUrl;

      if (url && accelerator.isMetadataUrl(url)) {
        xhr.addEventListener("loadend", function () {
          try {
            if (xhr.status < 200 || xhr.status >= 300) {
              return;
            }

            var payload = null;

            if (xhr.responseType === "json") {
              payload = xhr.response;
            } else if (
              xhr.responseType === "" ||
              xhr.responseType === "text"
            ) {
              var text = xhr.responseText;
              if (typeof text === "string" && text) {
                payload = JSON.parse(text);
              }
            }

            if (payload && typeof payload === "object") {
              accelerator.observeMetadata(payload);
            }
          } catch (_) {
            // Metadata observation must never affect the site's XHR.
          }
        }, { once: true });
      }

      if (
        url &&
        xhr.__dtrRangeHeader &&
        isDouyinVodUrl(url)
      ) {
        xhr.addEventListener("loadend", function () {
          observeMediaXhrIndex(xhr, url);
        }, { once: true });
      }

      return nativeXhrSend.apply(this, arguments);
    };
  }

  var observedReactMetadata = new WeakSet();
  var reactBootstrapInterval = null;

  function observeReactMetadataValue(value) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (observedReactMetadata.has(value)) {
      return;
    }
    observedReactMetadata.add(value);
    accelerator.observeMetadata(value);
  }

  function inspectReactFiber(element) {
    if (!element || typeof element !== "object") {
      return;
    }

    var fiberKey = Object.keys(element).find(function (key) {
      return key.indexOf("__reactFiber$") === 0;
    });
    if (!fiberKey) {
      return;
    }

    var fiber = element[fiberKey];
    for (var depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
      var props = fiber.memoizedProps;
      if (!props || typeof props !== "object") {
        continue;
      }

      [
        props.item,
        props.awemeInfo,
        props.nextAwemeInfo,
        props.prevAwemeInfo,
        props.slideData
      ].forEach(observeReactMetadataValue);
    }
  }

  function bootstrapReactMetadata() {
    try {
      var selectors = [
        '[data-e2e="feed-item"]',
        '[data-e2e="feed-active-video"]',
        '[data-e2e="video-detail"]'
      ];
      var seenElements = new Set();
      var elements = [];

      selectors.forEach(function (selector) {
        document.querySelectorAll(selector).forEach(function (element) {
          if (!seenElements.has(element) && elements.length < 12) {
            seenElements.add(element);
            elements.push(element);
          }
        });
      });

      elements.forEach(function (element) {
        inspectReactFiber(element);
        var parent = element.parentElement;
        for (var i = 0; parent && i < 3; i += 1, parent = parent.parentElement) {
          inspectReactFiber(parent);
        }
      });
    } catch (_) {
      // React metadata bootstrap is advisory only.
    }
  }

  reactBootstrapInterval = setInterval(bootstrapReactMetadata, 1200);
  setTimeout(bootstrapReactMetadata, 0);

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.source !== "DTR_EXTENSION") {
      return;
    }

    if (event.data.type === "DTR_CONFIG") {
      accelerator.updateConfig(event.data.config || {});
      return;
    }

    if (event.data.type === "DTR_RESET_STATS") {
      accelerator.resetStats();
      return;
    }

    if (event.data.type === "DTR_CLEAR_CACHES") {
      accelerator.clearCaches();
    }
  });

  var api = {
    version: window.DTRFetchAccelerator.VERSION,
    getConfig: function () {
      return accelerator.getConfig();
    },
    getStats: function () {
      return accelerator.getStats();
    },
    observeMetadata: function (payload) {
      return accelerator.observeMetadata(payload);
    },
    resetStats: function () {
      return accelerator.resetStats();
    },
    clearCaches: function () {
      return accelerator.clearCaches();
    },
    restore: function () {
      if (reactBootstrapInterval) {
        clearInterval(reactBootstrapInterval);
        reactBootstrapInterval = null;
      }
      if (window.fetch === wrappedFetch) {
        window.fetch = nativeFetch;
      }
      if (xhrPrototype) {
        if (xhrPrototype.open !== nativeXhrOpen) {
          xhrPrototype.open = nativeXhrOpen;
        }
        if (
          nativeXhrSetRequestHeader &&
          xhrPrototype.setRequestHeader !== nativeXhrSetRequestHeader
        ) {
          xhrPrototype.setRequestHeader = nativeXhrSetRequestHeader;
        }
        if (xhrPrototype.send !== nativeXhrSend) {
          xhrPrototype.send = nativeXhrSend;
        }
      }
    }
  };

  try {
    Object.defineProperty(window, "__DTR__", {
      configurable: true,
      value: api
    });
    Object.defineProperty(window, "__DTR_INSTALLED__", {
      configurable: true,
      value: true
    });
  } catch (_) {
    window.__DTR__ = api;
    window.__DTR_INSTALLED__ = true;
  }

  window.postMessage({
    source: "DTR_PAGE",
    type: "DTR_READY",
    version: api.version
  }, "*");
})();
