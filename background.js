importScripts("decoder.js");

// tabId -> chrome.runtime.Port for that tab's open devtools panel
const panelPorts = new Map();
// tabId -> boolean, whether we've attached the debugger to that tab
const attachedTabs = new Set();
// tabId -> Map(requestId -> in-flight request/response metadata)
const pendingByTab = new Map();

function getStore(tabId) {
  if (!pendingByTab.has(tabId)) pendingByTab.set(tabId, new Map());
  return pendingByTab.get(tabId);
}

function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  chrome.debugger.attach({ tabId }, "1.3", () => {
    if (chrome.runtime.lastError) {
      console.warn("[gRPC-Web Inspector] attach failed:", chrome.runtime.lastError.message);
      notifyPanel(tabId, { type: "status", ok: false, message: chrome.runtime.lastError.message });
      return;
    }
    attachedTabs.add(tabId);
    chrome.debugger.sendCommand({ tabId }, "Network.enable");
    notifyPanel(tabId, { type: "status", ok: true, message: "Attached — capturing gRPC-Web traffic" });
  });
}

function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
  } finally {
    attachedTabs.delete(tabId);
    pendingByTab.delete(tabId);
  }
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(result || {});
      }
    });
  });
}

function decodeBody(body, base64Encoded) {
  try {
    if (base64Encoded) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new TextEncoder().encode(body);
  } catch (e) {
    return null;
  }
}

function parseFramesSafe(bytes) {
  try {
    return GrpcWebDecoder.parseFrames(bytes);
  } catch (e) {
    return [{ type: "error", message: e.message }];
  }
}

function notifyPanel(tabId, message) {
  const port = panelPorts.get(tabId);
  if (port) {
    try {
      port.postMessage(message);
    } catch (e) {
      /* panel closed mid-flight */
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("panel-")) return;
  const tabId = parseInt(port.name.slice("panel-".length), 10);
  panelPorts.set(tabId, port);
  attachDebugger(tabId);

  port.onDisconnect.addListener(() => {
    panelPorts.delete(tabId);
    detachDebugger(tabId);
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || !attachedTabs.has(tabId)) return;
  const store = getStore(tabId);

  switch (method) {
    case "Network.requestWillBeSent": {
      store.set(params.requestId, {
        requestId: params.requestId,
        url: params.request.url,
        httpMethod: params.request.method,
        requestHeaders: params.request.headers,
        hasPostData: !!params.request.hasPostData,
        wallTime: params.wallTime,
      });
      break;
    }

    case "Network.responseReceived": {
      const entry = store.get(params.requestId);
      if (!entry) return;
      const headers = params.response.headers || {};
      const contentType = headers["content-type"] || headers["Content-Type"] || headers["Content-type"] || "";
      entry.contentType = contentType;
      entry.status = params.response.status;
      entry.responseHeaders = headers;
      entry.isGrpcWeb = contentType.toLowerCase().startsWith("application/grpc-web");
      break;
    }

    case "Network.loadingFinished": {
      const entry = store.get(params.requestId);
      if (!entry) return;
      if (!entry.isGrpcWeb) {
        store.delete(params.requestId);
        return;
      }

      (async () => {
        store.delete(params.requestId);

        const [responseResult, requestResult] = await Promise.all([
          sendCommand(tabId, "Network.getResponseBody", { requestId: params.requestId }),
          entry.hasPostData
            ? sendCommand(tabId, "Network.getRequestPostData", { requestId: params.requestId })
            : Promise.resolve(null),
        ]);

        if (responseResult.error) {
          console.warn("[gRPC-Web Inspector] getResponseBody failed:", responseResult.error);
          return;
        }

        const bytes = decodeBody(responseResult.body, responseResult.base64Encoded);
        if (!bytes) return;
        const frames = parseFramesSafe(bytes);

        let requestFrames = [];
        if (requestResult && !requestResult.error) {
          const reqBytes = decodeBody(requestResult.postData, requestResult.base64Encoded);
          if (reqBytes) requestFrames = parseFramesSafe(reqBytes);
        } else if (requestResult && requestResult.error) {
          console.warn("[gRPC-Web Inspector] getRequestPostData failed:", requestResult.error);
        }

        notifyPanel(tabId, {
          type: "grpc-call",
          call: {
            requestId: entry.requestId,
            url: entry.url,
            httpMethod: entry.httpMethod,
            status: entry.status,
            contentType: entry.contentType,
            requestHeaders: entry.requestHeaders,
            responseHeaders: entry.responseHeaders,
            requestFrames,
            frames,
            time: entry.wallTime,
          },
        });
      })();
      break;
    }

    case "Network.loadingFailed": {
      store.delete(params.requestId);
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
    pendingByTab.delete(source.tabId);
    notifyPanel(source.tabId, {
      type: "status",
      ok: false,
      message: "Debugger detached (DevTools closed or another debugger took over)",
    });
  }
});
