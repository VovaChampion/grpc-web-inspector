const tabId = chrome.devtools.inspectedWindow.tabId;
const port = chrome.runtime.connect({ name: "panel-" + tabId });

const calls = [];
let selectedRequestId = null;

const statusEl = document.getElementById("status");
const listEl = document.getElementById("call-list");
const detailEl = document.getElementById("detail");
const clearBtn = document.getElementById("clear-btn");
const autoscrollEl = document.getElementById("autoscroll");

clearBtn.addEventListener("click", () => {
  calls.length = 0;
  selectedRequestId = null;
  renderList();
  renderDetail(null);
});

port.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    statusEl.textContent = msg.message;
    statusEl.className = "status " + (msg.ok ? "ok" : "err");
  } else if (msg.type === "grpc-call") {
    calls.push(msg.call);
    renderList();
    if (autoscrollEl.checked) {
      selectedRequestId = msg.call.requestId;
      renderDetail(msg.call);
      highlightSelected();
    }
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (e) {
    return url;
  }
}

function renderList() {
  listEl.innerHTML = "";
  for (const call of calls) {
    const row = document.createElement("div");
    row.className = "call-row" + (call.requestId === selectedRequestId ? " selected" : "");
    row.dataset.requestId = call.requestId;

    const ok = call.status >= 200 && call.status < 300;
    const frameCount = call.frames.filter((f) => f.type === "message").length;
    const hasError = call.frames.some((f) => f.type === "error");

    row.innerHTML = `
      <div class="method-line">${escapeHtml(shortUrl(call.url))}</div>
      <div class="meta-line">
        <span class="pill ${ok && !hasError ? "status-ok" : "status-err"}">${call.status}</span>
        <span>${frameCount} msg${frameCount === 1 ? "" : "s"}</span>
      </div>
    `;
    row.addEventListener("click", () => {
      selectedRequestId = call.requestId;
      renderDetail(call);
      highlightSelected();
    });
    listEl.appendChild(row);
  }
  if (autoscrollEl.checked) listEl.scrollTop = listEl.scrollHeight;
}

function highlightSelected() {
  for (const row of listEl.children) {
    row.classList.toggle("selected", row.dataset.requestId === selectedRequestId);
  }
}

function renderHeadersTable(headers) {
  if (!headers || Object.keys(headers).length === 0) return "<div>—</div>";
  const rows = Object.entries(headers)
    .map(
      ([k, v]) =>
        `<tr><td class="key">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`
    )
    .join("");
  return `<table class="headers-table">${rows}</table>`;
}

function renderFieldValue(value) {
  switch (value.kind) {
    case "varint":
      return `<span class="field-kind">varint</span> ${escapeHtml(value.value)}`;
    case "fixed64":
      return `<span class="field-kind">fixed64</span> double=${value.double} | uint64=${value.uint64}`;
    case "fixed32":
      return `<span class="field-kind">fixed32</span> float=${value.float} | uint32=${value.uint32}`;
    case "bytes": {
      let out = `<span class="field-kind">bytes</span> (${value.byteLength}B)`;
      if (value.asString !== null) {
        out += `<div>string: "${escapeHtml(value.asString)}"</div>`;
      }
      if (value.asMessage && value.asMessage.length) {
        out += `<div class="field-nested">${renderFieldTree(value.asMessage)}</div>`;
      }
      if (value.asString === null && (!value.asMessage || !value.asMessage.length)) {
        out += `<div class="raw-b64">${value.bytesBase64}</div>`;
      }
      return out;
    }
    default:
      return escapeHtml(JSON.stringify(value));
  }
}

function renderFieldTree(fields) {
  if (!fields || !fields.length) return "<div class='field-line'>(empty message)</div>";
  return fields
    .map(
      (f) =>
        `<div class="field-line"><span class="field-num">#${f.fieldNumber}</span> ${renderFieldValue(f.value)}</div>`
    )
    .join("");
}

function renderFrame(frame, index) {
  if (frame.type === "trailer") {
    const trailerRows = Object.entries(frame.trailers)
      .map(([k, v]) => `<div>${escapeHtml(k)}: ${escapeHtml(v)}</div>`)
      .join("");
    return `
      <div class="frame">
        <div class="frame-header"><span class="frame-type trailer">TRAILER</span></div>
        <div class="frame-body">${trailerRows || "<em>empty</em>"}</div>
      </div>
    `;
  }
  if (frame.type === "error") {
    return `
      <div class="frame">
        <div class="frame-header"><span class="frame-type error">PARSE ERROR</span></div>
        <div class="frame-body decode-error">${escapeHtml(frame.message)}</div>
      </div>
    `;
  }
  // message frame
  let body;
  if (frame.decodeError) {
    body = `<div class="decode-error">${escapeHtml(frame.decodeError)}</div><div class="raw-b64">${frame.bytesBase64}</div>`;
  } else {
    body = `<div class="field-tree">${renderFieldTree(frame.decoded)}</div>`;
  }
  return `
    <div class="frame">
      <div class="frame-header">
        <span class="frame-type">MESSAGE ${index + 1}</span>
        <span>${frame.byteLength} bytes</span>
        ${frame.compressed ? '<span style="color:var(--warn)">compressed</span>' : ""}
      </div>
      <div class="frame-body">${body}</div>
    </div>
  `;
}

function renderDetail(call) {
  if (!call) {
    detailEl.innerHTML = `<div id="empty-state">Select a call to inspect its frames.</div>`;
    return;
  }

  const messageFrames = call.frames.filter((f) => f.type === "message");
  const trailerFrames = call.frames.filter((f) => f.type === "trailer");
  const errorFrames = call.frames.filter((f) => f.type === "error");

  detailEl.innerHTML = `
    <h1 class="call-title">${escapeHtml(call.httpMethod)} ${escapeHtml(call.url)}</h1>
    <div>Status: <strong>${call.status}</strong> · Content-Type: <code>${escapeHtml(call.contentType)}</code></div>

    <div class="section">
      <div class="section-title">Request headers</div>
      ${renderHeadersTable(call.requestHeaders)}
    </div>

    <div class="section">
      <div class="section-title">Response headers</div>
      ${renderHeadersTable(call.responseHeaders)}
    </div>

    <div class="section">
      <div class="section-title">Frames (${messageFrames.length} message${messageFrames.length === 1 ? "" : "s"}, ${trailerFrames.length} trailer${trailerFrames.length === 1 ? "" : "s"}${errorFrames.length ? `, ${errorFrames.length} error` : ""})</div>
      ${call.frames.map((f, i) => renderFrame(f, i)).join("")}
    </div>
  `;
}
