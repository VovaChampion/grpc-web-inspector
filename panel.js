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
const viewToggleEl = document.getElementById("view-toggle");

// "tree" (word-labeled collapsible tree) or "json" (real JSON syntax)
let viewMode = "tree";

// JSON view is one flat <pre> block with no <details> to toggle, so
// Expand/Collapse all only make sense in tree view.
function updateExpandCollapseAvailability() {
  const disabled = viewMode !== "tree";
  expandBtn.disabled = disabled;
  collapseBtn.disabled = disabled;
}
updateExpandCollapseAvailability();

viewToggleEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".view-btn");
  if (!btn || btn.dataset.mode === viewMode) return;
  viewMode = btn.dataset.mode;
  viewToggleEl.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b === btn));
  updateExpandCollapseAvailability();
  const current = calls.find((c) => c.requestId === selectedRequestId);
  if (current) renderDetail(current);
});

// protobuf.js compiles its encode/decode functions at runtime via
// `new Function(...)`, which the extension's normal CSP (script-src 'self')
// blocks as unsafe-eval. So all actual protobuf.js work (parsing .proto
// files, decoding messages) happens in a sandboxed page (sandbox.html/.js,
// which gets its own relaxed CSP) — this bridges to it over postMessage.
const sandboxFrame = document.createElement("iframe");
sandboxFrame.src = "sandbox.html";
sandboxFrame.style.display = "none";
document.body.appendChild(sandboxFrame);

let protoLoaded = false; // mirrors whether the sandbox has a schema loaded
let sandboxReadyResolve;
const sandboxReadyPromise = new Promise((resolve) => {
  sandboxReadyResolve = resolve;
});
let sandboxMsgId = 0;
const sandboxPending = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== sandboxFrame.contentWindow) return;
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "sandbox-ready") {
    sandboxReadyResolve();
    return;
  }
  const pending = sandboxPending.get(msg.id);
  if (!pending) return;
  sandboxPending.delete(msg.id);
  if (msg.ok) pending.resolve(msg.result);
  else pending.reject(new Error(msg.error || "sandbox error"));
});

async function callSandbox(cmd, payload) {
  await sandboxReadyPromise;
  const id = ++sandboxMsgId;
  return new Promise((resolve, reject) => {
    sandboxPending.set(id, { resolve, reject });
    sandboxFrame.contentWindow.postMessage(Object.assign({ id, cmd }, payload), "*");
  });
}

// google/api/*.proto (annotations.proto, http.proto) only define HTTP
// transcoding *options* on RPC methods (extending google.protobuf.
// MethodOptions) — never actual message field types. Resolving that extend
// target needs the full google/protobuf/descriptor.proto, which we don't
// bundle, so loading them just breaks schema resolution for no benefit here.
function isIrrelevantAnnotationFile(relativePath) {
  return /(^|\/)google\/api\/(annotations|http)\.proto$/i.test(relativePath);
}

// chrome.storage.local is shared across every tab's DevTools panel (each tab
// gets its own panel.js + sandbox instance with no memory of the others), so
// persisting the loaded schema here means "load .proto" is a one-time thing
// rather than a per-tab, per-DevTools-session chore.
const PROTO_STORAGE_KEY = "grpcWebInspector.protoSchema";

async function applyLoadedSchema(files, skippedCount, sourceLabel) {
  const { serviceCount, messageCount } = await callSandbox("loadSchema", { files });
  protoLoaded = true;
  protoLabel.textContent = `${sourceLabel} (${serviceCount} service${serviceCount === 1 ? "" : "s"}, ${messageCount} message${messageCount === 1 ? "" : "s"})`;
  protoLabel.title = `Click to load a different .proto schema${skippedCount ? ` — ${skippedCount} file${skippedCount === 1 ? "" : "s"} skipped (google/api/*.proto isn't needed for message decoding)` : ""}`;
  chrome.storage.local.set({ [PROTO_STORAGE_KEY]: { files, skippedCount, sourceLabel } });
  // re-render whatever's currently selected so it picks up the new schema
  const current = calls.find((c) => c.requestId === selectedRequestId);
  if (current) renderDetail(current);
}

// Auto-loads whatever schema was last successfully loaded (by this tab or
// any other), so reopening DevTools doesn't mean re-picking the folder.
(async function restoreProtoSchema() {
  try {
    const stored = await chrome.storage.local.get(PROTO_STORAGE_KEY);
    const saved = stored[PROTO_STORAGE_KEY];
    if (!saved || !saved.files || !saved.files.length) return;
    await applyLoadedSchema(saved.files, saved.skippedCount || 0, saved.sourceLabel || "restored schema");
  } catch (e) {
    console.warn("[gRPC-Web Inspector] couldn't restore saved .proto schema:", e.message);
  }
})();

protoFileInput.addEventListener("change", async () => {
  const allFiles = Array.from(protoFileInput.files || []);
  if (!allFiles.length) return;

  // webkitRelativePath is set when a whole folder was picked; falls back to
  // just the filename for a plain multi-file selection.
  const relPath = (f) => f.webkitRelativePath || f.name;
  const protoFiles = allFiles.filter((f) => f.name.toLowerCase().endsWith(".proto"));
  const selected = protoFiles.filter((f) => !isIrrelevantAnnotationFile(relPath(f)));
  const skippedCount = protoFiles.length - selected.length;

  if (!selected.length) {
    protoLabel.textContent = "Load .proto";
    alert("No usable .proto files found in that selection.");
    protoFileInput.value = "";
    return;
  }

  try {
    const files = await Promise.all(
      selected.map(async (f) => ({ name: f.name, relPath: relPath(f), text: await f.text() })),
    );
    const sourceLabel = files.length === 1 ? files[0].name : `${files.length} files`;
    await applyLoadedSchema(files, skippedCount, sourceLabel);
  } catch (e) {
    protoLoaded = false;
    protoLabel.textContent = "Load .proto";
    alert(
      "Couldn't parse the selected .proto schema: " +
        e.message +
        "\n\nMake sure you selected every .proto file this schema depends on (its whole source folder works best).",
    );
  } finally {
    protoFileInput.value = "";
  }
});

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

// ---- JSON view (used for both schema-decoded and schema-less messages) ----

// Converts one schema-less decoded value into a plain JS value/object, using
// the same string-vs-nested-message preference as the tree view, so both
// views agree on what a given byte sequence "is".
function genericValueToPlain(value) {
  switch (value.kind) {
    case "varint":
      return value.value;
    case "fixed32":
      return value.float;
    case "fixed64":
      return value.double;
    case "bytes":
      if (value.asString !== null) return value.asString;
      if (value.asMessage && value.asMessage.length) return genericFieldsToPlain(value.asMessage);
      return `<${value.byteLength} raw bytes: ${value.bytesBase64}>`;
    default:
      return null;
  }
}

// Converts a schema-less decoded field list (number-keyed, protobuf has no
// field names without a .proto) into a plain object keyed by "#N", grouping
// repeated occurrences into arrays — mirrors renderFieldTree's grouping.
function genericFieldsToPlain(fields) {
  if (!fields || !fields.length) return {};
  const order = [];
  const groups = new Map();
  for (const f of fields) {
    if (!groups.has(f.fieldNumber)) {
      groups.set(f.fieldNumber, []);
      order.push(f.fieldNumber);
    }
    groups.get(f.fieldNumber).push(f.value);
  }
  const obj = {};
  for (const num of order) {
    const values = groups.get(num).map(genericValueToPlain);
    obj[`#${num}`] = values.length === 1 ? values[0] : values;
  }
  return obj;
}

// Basic JSON syntax highlighting (regex-based, same approach devtools/most
// JSON viewers use) — operates on already-stringified, HTML-escaped JSON.
function syntaxHighlightJson(json) {
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "json-number";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-string";
      } else if (/^(true|false)$/.test(match)) {
        cls = "json-boolean";
      } else if (match === "null") {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

function renderAsJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  return `<pre class="json-view">${syntaxHighlightJson(json)}</pre>`;
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

// decodeResult comes from the sandbox's "decode" command:
// { hasType: false }                                  — no schema/type to try
// { hasType: true, value, typeFullName }               — decoded successfully
// { hasType: true, error, typeFullName }               — type existed, decode threw
function renderFrame(frame, index, decodeResult) {
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

  // message frame — prefer the schema-decoded object when a .proto matched
  // and actually decoded, otherwise fall back to the schema-less generic
  // decode (surfacing why the schema attempt failed, if it was tried).
  const usedSchema = !!(decodeResult && decodeResult.hasType && "value" in decodeResult);
  const schemaError = decodeResult && decodeResult.hasType && decodeResult.error;
  const plainObj = usedSchema ? decodeResult.value : frame.decodeError ? null : genericFieldsToPlain(frame.decoded);

  let body;
  if (plainObj === null) {
    body = `<div class="decode-error">${escapeHtml(frame.decodeError)}</div><div class="raw-b64">${frame.bytesBase64}</div>`;
  } else if (viewMode === "json") {
    body = renderAsJson(plainObj);
  } else if (usedSchema) {
    body = `<div class="field-tree">${renderObjectTree(plainObj)}</div>`;
  } else {
    body = `<div class="field-tree">${renderFieldTree(frame.decoded)}</div>`;
  }

  return `
    <div class="frame">
      <div class="frame-header">
        <span class="frame-type">MESSAGE ${index + 1}</span>
        <span>${frame.byteLength} bytes</span>
        ${usedSchema ? `<span class="schema-badge">${escapeHtml(decodeResult.typeFullName)}</span>` : ""}
        ${schemaError ? `<span style="color:var(--warn)" title="${escapeHtml(schemaError)}">schema decode failed</span>` : ""}
        ${frame.compressed ? '<span style="color:var(--warn)">compressed</span>' : ""}
      </div>
      <div class="frame-body">${body}</div>
    </div>
  `;
}

// Same "schema decode, else generic decode, else surface the error" logic as
// renderFrame's body, but returning a plain JSON-able value instead of HTML —
// used to build the single combined request/response JSON blob below.
function frameToPlainOrError(frame, decodeResult) {
  if (decodeResult && decodeResult.hasType && "value" in decodeResult) return decodeResult.value;
  const plain = frame.decodeError ? { __decodeError: frame.decodeError } : genericFieldsToPlain(frame.decoded);
  if (decodeResult && decodeResult.hasType && decodeResult.error) plain.__schemaError = decodeResult.error;
  return plain;
}

// decodeResults must be the same length/order as frames (see decodeFrames
// below) so each message frame lines up with its precomputed decode result.
function messagesToPlain(frames, decodeResults) {
  const out = [];
  (frames || []).forEach((f, i) => {
    if (f.type !== "message") return;
    out.push(frameToPlainOrError(f, decodeResults[i]));
  });
  return out;
}

// gRPC-Web URLs look like https://host/package.Service/MethodName — used as
// a method label when no .proto is loaded to resolve a nicer one.
function methodNameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || url;
  } catch (e) {
    return url;
  }
}

// Builds the { method, request, response } shape for the combined JSON view —
// one message collapses to an object, several (streaming) become an array.
function buildCombinedJson(call, schemaInfo, requestDecoded, responseDecoded) {
  const obj = {
    method: schemaInfo ? `${schemaInfo.serviceName}/${schemaInfo.methodName}` : methodNameFromUrl(call.url),
  };

  const reqMessages = messagesToPlain(call.requestFrames, requestDecoded);
  if (reqMessages.length) obj.request = reqMessages.length === 1 ? reqMessages[0] : reqMessages;

  const resMessages = messagesToPlain(call.frames, responseDecoded);
  if (resMessages.length) obj.response = resMessages.length === 1 ? resMessages[0] : resMessages;

  const trailer = (call.frames || []).find((f) => f.type === "trailer");
  if (trailer) {
    const status = {};
    if (trailer.trailers["grpc-status"] !== undefined) status.code = trailer.trailers["grpc-status"];
    if (trailer.trailers["grpc-message"] !== undefined) status.message = trailer.trailers["grpc-message"];
    if (Object.keys(status).length) obj.status = status;
  }

  const reqParseErrors = (call.requestFrames || []).filter((f) => f.type === "error").map((f) => f.message);
  if (reqParseErrors.length) obj.requestParseErrors = reqParseErrors;
  const resParseErrors = (call.frames || []).filter((f) => f.type === "error").map((f) => f.message);
  if (resParseErrors.length) obj.responseParseErrors = resParseErrors;

  return obj;
}

// Requests a schema decode for every "message" frame in `frames` from the
// sandbox, in parallel. Keeps the same length/order as `frames` (with `null`
// for non-message frames) so results line up by index with the source array.
async function decodeFrames(frames, url, direction) {
  return Promise.all(
    (frames || []).map((f) => {
      if (f.type !== "message") return null;
      return callSandbox("decode", { url, direction, bytesBase64: f.bytesBase64 }).catch((e) => ({
        hasType: true,
        error: e.message,
      }));
    }),
  );
}

// Bumped on every renderDetail call so a slow, now-stale in-flight render
// (e.g. the user clicked a different call while sandbox round-trips were
// still pending) doesn't clobber a newer selection's HTML when it resolves.
let renderGeneration = 0;

async function renderDetail(call) {
  if (!call) {
    detailEl.innerHTML = `<div id="empty-state">Select a call to inspect its frames.</div>`;
    return;
  }

  const myGeneration = ++renderGeneration;

  const requestFrames = call.requestFrames || [];
  const requestMessageFrames = requestFrames.filter((f) => f.type === "message");
  const requestErrorFrames = requestFrames.filter((f) => f.type === "error");

  const messageFrames = call.frames.filter((f) => f.type === "message");
  const trailerFrames = call.frames.filter((f) => f.type === "trailer");
  const errorFrames = call.frames.filter((f) => f.type === "error");

  let methodInfo = null;
  try {
    methodInfo = await callSandbox("resolveMethod", { url: call.url });
  } catch (e) {
    methodInfo = null;
  }
  const schemaInfo =
    methodInfo && methodInfo.matched ? { serviceName: methodInfo.serviceName, methodName: methodInfo.methodName } : null;

  const [requestDecoded, responseDecoded] = await Promise.all([
    decodeFrames(requestFrames, call.url, "request"),
    decodeFrames(call.frames, call.url, "response"),
  ]);

  if (myGeneration !== renderGeneration) return; // a newer call was selected meanwhile

  let schemaStatusHtml = "";
  if (methodInfo && methodInfo.loaded) {
    schemaStatusHtml = methodInfo.matched
      ? `<div class="schema-status ok">Decoding with schema: <code>${escapeHtml(methodInfo.serviceName)}/${escapeHtml(methodInfo.methodName)}</code></div>`
      : `<div class="schema-status warn">No matching service/method found in the loaded .proto for this URL — showing raw field numbers.</div>`;
  }

  const framesHtml =
    viewMode === "json"
      ? `<div class="section"><div class="section-title">JSON</div>${renderAsJson(buildCombinedJson(call, schemaInfo, requestDecoded, responseDecoded))}</div>`
      : `
    <div class="section">
      <div class="section-title">Request (${requestMessageFrames.length} message${requestMessageFrames.length === 1 ? "" : "s"}${requestErrorFrames.length ? `, ${requestErrorFrames.length} error` : ""})</div>
      ${requestFrames.length ? requestFrames.map((f, i) => renderFrame(f, i, requestDecoded[i])).join("") : "<div class='field-line'>(no request body captured)</div>"}
    </div>

    <div class="section">
      <div class="section-title">Response (${messageFrames.length} message${messageFrames.length === 1 ? "" : "s"}, ${trailerFrames.length} trailer${trailerFrames.length === 1 ? "" : "s"}${errorFrames.length ? `, ${errorFrames.length} error` : ""})</div>
      ${call.frames.map((f, i) => renderFrame(f, i, responseDecoded[i])).join("")}
    </div>`;

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

    ${framesHtml}
  `;
}
