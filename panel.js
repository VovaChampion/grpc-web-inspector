const tabId = chrome.devtools.inspectedWindow.tabId;
const port = chrome.runtime.connect({ name: "panel-" + tabId });

const calls = [];
let selectedRequestId = null;

const statusEl = document.getElementById("status");
const listEl = document.getElementById("call-list");
const detailEl = document.getElementById("detail");
const clearBtn = document.getElementById("clear-btn");
const expandBtn = document.getElementById("expand-btn");
const collapseBtn = document.getElementById("collapse-btn");
const autoscrollEl = document.getElementById("autoscroll");
const protoFileInput = document.getElementById("proto-file");
const protoLabel = document.getElementById("proto-label");

// Parsed protobuf.Root once a .proto file is loaded, else null (falls back
// to the schema-less wire-format view everywhere).
let protoRoot = null;

protoFileInput.addEventListener("change", async () => {
  const file = protoFileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = protobuf.parse(text, new protobuf.Root(), { keepCase: true });
    parsed.root.resolveAll();
    protoRoot = parsed.root;
    const serviceCount = countNested(protoRoot, (obj) => obj instanceof protobuf.Service);
    const messageCount = countNested(protoRoot, (obj) => obj instanceof protobuf.Type);
    protoLabel.textContent = `${file.name} (${serviceCount} service${serviceCount === 1 ? "" : "s"}, ${messageCount} message${messageCount === 1 ? "" : "s"})`;
    protoLabel.title = "Click to load a different .proto file";
    // re-render whatever's currently selected so it picks up the new schema
    const current = calls.find((c) => c.requestId === selectedRequestId);
    if (current) renderDetail(current);
  } catch (e) {
    protoLabel.textContent = "Load .proto";
    alert("Couldn't parse that .proto file: " + e.message);
  } finally {
    protoFileInput.value = "";
  }
});

function countNested(namespace, predicate) {
  let count = 0;
  if (namespace.nestedArray) {
    for (const obj of namespace.nestedArray) {
      if (predicate(obj)) count++;
      count += countNested(obj, predicate);
    }
  }
  return count;
}

// gRPC-Web calls URLs look like https://host/package.Service/MethodName —
// match that against the loaded schema to find the exact request/response
// message types, so decoded fields can show real names instead of numbers.
function resolveMethodForUrl(url) {
  if (!protoRoot) return null;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (e) {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const serviceName = parts[parts.length - 2];
  const methodName = parts[parts.length - 1];
  try {
    const service = protoRoot.lookupService(serviceName);
    const method = service.methods[methodName];
    if (!method) return null;
    method.resolve();
    return {
      serviceName,
      methodName,
      requestType: method.resolvedRequestType,
      responseType: method.resolvedResponseType,
    };
  } catch (e) {
    return null;
  }
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

clearBtn.addEventListener("click", () => {
  calls.length = 0;
  selectedRequestId = null;
  renderList();
  renderDetail(null);
});

expandBtn.addEventListener("click", () => {
  detailEl.querySelectorAll("details").forEach((d) => (d.open = true));
});

collapseBtn.addEventListener("click", () => {
  detailEl.querySelectorAll("details").forEach((d) => (d.open = false));
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
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
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
    .map(([k, v]) => `<tr><td class="key">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  return `<table class="headers-table">${rows}</table>`;
}

// Is this a length-delimited field better read as a nested message than as text?
// (The decoder only offers asString when the bytes decode as printable UTF-8, so
// this is only ambiguous when both interpretations exist — here we prefer the
// message view only when there's no valid string reading at all.)
function isNestedMessage(value) {
  return value.kind === "bytes" && value.asString === null && value.asMessage && value.asMessage.length > 0;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// A short one-line hint used in collapsed <summary> headers, so you can scan
// a list of repeated fields (e.g. 4 catalog items) without expanding each one.
function fieldPreview(value, depth) {
  depth = depth || 0;
  if (depth > 5) return "";
  switch (value.kind) {
    case "varint":
      return String(value.value);
    case "fixed32":
      return String(value.float);
    case "fixed64":
      return String(value.double);
    case "bytes":
      if (value.asString !== null) return truncate(value.asString, 60);
      if (value.asMessage && value.asMessage.length) {
        for (const f of value.asMessage) {
          const p = fieldPreview(f.value, depth + 1);
          if (p) return p;
        }
      }
      return `${value.byteLength}B`;
    default:
      return "";
  }
}

function renderScalar(value) {
  switch (value.kind) {
    case "varint":
      return `<span class="field-kind">int</span> ${escapeHtml(value.value)}`;
    case "fixed64":
      return `<span class="field-kind">fixed64</span> double=${value.double} · uint64=${value.uint64}`;
    case "fixed32":
      return `<span class="field-kind">fixed32</span> float=${value.float} · uint32=${value.uint32}`;
    case "bytes":
      if (value.asString !== null) {
        return `<span class="field-kind">string</span> "${escapeHtml(value.asString)}"`;
      }
      return `<span class="field-kind">bytes</span> (${value.byteLength}B)<div class="raw-b64">${value.bytesBase64}</div>`;
    default:
      return escapeHtml(JSON.stringify(value));
  }
}

// Renders one field value's *contents* — used inside an already-labeled
// <details> (a repeated item, or a single nested-message field).
function renderValueBody(value, depth) {
  if (isNestedMessage(value)) return renderFieldTree(value.asMessage, depth);
  return `<div class="field-line">${renderScalar(value)}</div>`;
}

function renderSingleField(num, value, depth) {
  if (isNestedMessage(value)) {
    const preview = fieldPreview(value);
    return `
      <details class="field-details"${depth === 0 ? " open" : ""}>
        <summary class="field-summary">
          <span class="field-num">#${num}</span>
          <span class="field-kind">message</span>
          ${preview ? `<span class="preview">— ${escapeHtml(preview)}</span>` : ""}
        </summary>
        <div class="field-nested">${renderFieldTree(value.asMessage, depth + 1)}</div>
      </details>`;
  }
  return `<div class="field-line"><span class="field-num">#${num}</span> ${renderScalar(value)}</div>`;
}

function renderRepeatedItem(index, value, depth) {
  const preview = fieldPreview(value);
  return `
    <details class="field-details">
      <summary class="field-summary">
        item ${index + 1}${preview ? ` <span class="preview">— ${escapeHtml(preview)}</span>` : ""}
      </summary>
      <div class="field-nested">${renderValueBody(value, depth + 1)}</div>
    </details>`;
}

function renderGroupedField(num, group, depth) {
  if (group.length === 1) return renderSingleField(num, group[0].value, depth);
  const items = group.map((f, i) => renderRepeatedItem(i, f.value, depth)).join("");
  return `
    <details class="field-details repeated"${depth === 0 ? " open" : ""}>
      <summary class="field-summary">
        <span class="field-num">#${num}</span>
        <span class="repeat-badge">× ${group.length}</span>
      </summary>
      <div class="field-nested">${items}</div>
    </details>`;
}

// Groups repeated occurrences of the same field number together (protobuf
// represents "repeated" fields as several entries with the same tag) instead
// of listing them as a flat, hard-to-scan sequence.
function renderFieldTree(fields, depth) {
  depth = depth || 0;
  if (!fields || !fields.length) return "<div class='field-line'>(empty message)</div>";
  const order = [];
  const groups = new Map();
  for (const f of fields) {
    if (!groups.has(f.fieldNumber)) {
      groups.set(f.fieldNumber, []);
      order.push(f.fieldNumber);
    }
    groups.get(f.fieldNumber).push(f);
  }
  return order.map((num) => renderGroupedField(num, groups.get(num), depth)).join("");
}

// ---- Schema-aware rendering (used once a .proto is loaded and matches) ----

function namedPreview(value, depth) {
  depth = depth || 0;
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value !== "object") return truncate(String(value), 60);
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = namedPreview(v, depth + 1);
      if (p) return p;
    }
    return "";
  }
  for (const key of Object.keys(value)) {
    const p = namedPreview(value[key], depth + 1);
    if (p) return p;
  }
  return "";
}

function renderNamedScalar(value) {
  if (typeof value === "string") return `<span class="field-kind">string</span> "${escapeHtml(value)}"`;
  if (typeof value === "boolean") return `<span class="field-kind">bool</span> ${value}`;
  if (typeof value === "number" || typeof value === "bigint") {
    return `<span class="field-kind">number</span> ${escapeHtml(String(value))}`;
  }
  if (value === null || value === undefined) return `<span class="field-kind">null</span>`;
  return escapeHtml(JSON.stringify(value));
}

function renderRepeatedNamedItem(index, value, depth) {
  const preview = namedPreview(value);
  const body =
    value !== null && typeof value === "object"
      ? renderObjectTree(value, depth + 1)
      : `<div class="field-line">${renderNamedScalar(value)}</div>`;
  return `
    <details class="field-details">
      <summary class="field-summary">item ${index + 1}${preview ? ` <span class="preview">— ${escapeHtml(preview)}</span>` : ""}</summary>
      <div class="field-nested">${body}</div>
    </details>`;
}

function renderNamedField(key, value, depth) {
  if (Array.isArray(value)) {
    const items = value.map((v, i) => renderRepeatedNamedItem(i, v, depth + 1)).join("");
    return `
      <details class="field-details repeated"${depth === 0 ? " open" : ""}>
        <summary class="field-summary"><span class="field-num">${escapeHtml(key)}</span><span class="repeat-badge">× ${value.length}</span></summary>
        <div class="field-nested">${items || "<div class='field-line'>(empty)</div>"}</div>
      </details>`;
  }
  if (value !== null && typeof value === "object") {
    const preview = namedPreview(value);
    return `
      <details class="field-details"${depth === 0 ? " open" : ""}>
        <summary class="field-summary">
          <span class="field-num">${escapeHtml(key)}</span>
          <span class="field-kind">message</span>
          ${preview ? `<span class="preview">— ${escapeHtml(preview)}</span>` : ""}
        </summary>
        <div class="field-nested">${renderObjectTree(value, depth + 1)}</div>
      </details>`;
  }
  return `<div class="field-line"><span class="field-num">${escapeHtml(key)}</span> ${renderNamedScalar(value)}</div>`;
}

function renderObjectTree(obj, depth) {
  depth = depth || 0;
  if (obj === null || obj === undefined) return `<div class="field-line">null</div>`;
  const keys = Object.keys(obj);
  if (!keys.length) return `<div class="field-line">(empty message)</div>`;
  return keys.map((k) => renderNamedField(k, obj[k], depth)).join("");
}

// Tries to decode a message frame's raw bytes against the resolved schema
// type for this call. Returns rendered HTML, or null if there's no schema
// match / decoding fails, so the caller can fall back to the generic view.
function tryRenderWithSchema(frame, schemaInfo) {
  if (!schemaInfo || !schemaInfo.responseType || frame.compressed) return null;
  try {
    const bytes = base64ToBytes(frame.bytesBase64);
    const message = schemaInfo.responseType.decode(bytes);
    const obj = schemaInfo.responseType.toObject(message, {
      longs: "string",
      enums: "string",
      bytes: "base64",
      defaults: false,
    });
    return `<div class="field-tree">${renderObjectTree(obj)}</div>`;
  } catch (e) {
    return null;
  }
}

function renderFrame(frame, index, schemaInfo) {
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
  // message frame — prefer the schema-decoded view when a .proto matched
  let body;
  let usedSchema = false;
  const schemaHtml = tryRenderWithSchema(frame, schemaInfo);
  if (schemaHtml !== null) {
    body = schemaHtml;
    usedSchema = true;
  } else if (frame.decodeError) {
    body = `<div class="decode-error">${escapeHtml(frame.decodeError)}</div><div class="raw-b64">${frame.bytesBase64}</div>`;
  } else {
    body = `<div class="field-tree">${renderFieldTree(frame.decoded)}</div>`;
  }
  return `
    <div class="frame">
      <div class="frame-header">
        <span class="frame-type">MESSAGE ${index + 1}</span>
        <span>${frame.byteLength} bytes</span>
        ${usedSchema ? `<span class="schema-badge">${escapeHtml(schemaInfo.responseType.fullName.replace(/^\./, ""))}</span>` : ""}
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
  const schemaInfo = resolveMethodForUrl(call.url);

  let schemaStatusHtml = "";
  if (protoRoot) {
    schemaStatusHtml = schemaInfo
      ? `<div class="schema-status ok">Decoding with schema: <code>${escapeHtml(schemaInfo.serviceName)}/${escapeHtml(schemaInfo.methodName)}</code></div>`
      : `<div class="schema-status warn">No matching service/method found in the loaded .proto for this URL — showing raw field numbers.</div>`;
  }

  detailEl.innerHTML = `
    <h1 class="call-title">${escapeHtml(call.httpMethod)} ${escapeHtml(call.url)}</h1>
    <div>Status: <strong>${call.status}</strong> · Content-Type: <code>${escapeHtml(call.contentType)}</code></div>
    ${schemaStatusHtml}

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
      ${call.frames.map((f, i) => renderFrame(f, i, schemaInfo)).join("")}
    </div>
  `;
}
