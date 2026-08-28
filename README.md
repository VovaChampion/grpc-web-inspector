# gRPC-Web Inspector

A DevTools panel for inspecting gRPC-Web traffic, built on the **Chrome DevTools
Protocol** (`chrome.debugger`) instead of the public `devtools.network` API.

## Why this is more stable than the existing extensions

The gRPC-Web extensions you tried both use `chrome.devtools.network.onRequestFinished`
and `request.getContent()`, which is unreliable for binary and streamed bodies —
that's almost certainly the "works sometimes" behavior you saw. This extension
instead:

1. Attaches via `chrome.debugger` and listens to raw CDP `Network.*` events.
2. Waits for `Network.loadingFinished`, then calls `Network.getResponseBody`
   (and, when present, `Network.getRequestPostData`), which return the
   **fully reassembled** bodies (Chrome does the chunk reassembly and
   base64-safe binary handling internally) — so streaming responses, request
   payloads, and binary fields come through intact rather than split mid-frame
   or mangled as text.
3. Parses the 5-byte gRPC-Web frame header itself (flag byte + big-endian
   length) rather than assuming JSON/text, and separates message frames from
   trailer frames correctly.
4. Walks the raw protobuf wire format (varint/fixed32/fixed64/length-delimited)
   without needing a `.proto` file, so it degrades gracefully instead of
   crashing or showing nothing when it can't know field names.

## Load it (development / personal use)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this `grpc-web-inspector` folder
4. Open DevTools on a page that makes gRPC-Web calls → you'll see a **gRPC-Web** tab
5. Reload the page or trigger a call — you'll see a small "this extension is
   debugging this browser" banner while the panel is open. That's expected;
   it's what gives you byte-accurate capture.
6. **Load your `.proto` schema** (see below) — without it, every field shows
   as a raw number (`#1`, `#2`, ...) instead of its real name, since the
   protobuf wire format itself never carries field names.

To use it in an Incognito window: open the extension's **Details** page in
`chrome://extensions` and toggle **Allow in Incognito** (off by default for
every extension). Reloading the unpacked extension after a code change
occasionally resets this — worth a quick check if incognito capture stops
working after an update.

## Loading a `.proto` schema (important)

Click **Load .proto** in the toolbar and select the folder containing your
service's `.proto` files. A few things to know:

- **It's a folder picker, not a single-file picker.** Select the whole
  directory — the service's own file plus everything it `import`s (message
  definitions, shared types, etc.). A tool like `buf export` (from a
  [Buf Schema Registry](https://buf.build) module) is the easiest way to get
  a clean, self-contained folder of `.proto` sources to point it at.
- **A handful of common types are bundled** so you don't have to hunt them
  down: `google.type.DateTime`, `Money`, `Date`, `TimeOfDay`, `DayOfWeek`,
  `LatLng`, and the standard `google.protobuf` well-known types (`Any`,
  `Timestamp`, `Struct`, `Empty`, `FieldMask`, wrapper types). If your
  selection includes real copies of these, yours win.
- **`google/api/annotations.proto` and `google/api/http.proto` are skipped
  automatically** if present — they only carry HTTP-transcoding *options* on
  RPC methods, never actual message fields, and resolving them would need
  Google's much larger `descriptor.proto`, which isn't worth bundling for no
  benefit.
- **It's remembered.** Once a schema loads successfully, it's saved via
  `chrome.storage.local` and auto-restored the next time any tab's DevTools
  panel opens — you don't need to reload it per-tab or per-session. Loading a
  new folder replaces the saved one. (If you ever hit a "quota exceeded"
  error here, your schema folder is unusually large — `chrome.storage.local`
  has a ~10 MB cap.)
- If a call's fields still show as `#1`, `#2`, etc. after loading, check the
  small status line under the call's title — it tells you whether no schema
  is loaded, or a schema is loaded but doesn't match that call's service/method,
  or the message fields you'd expect to have loaded via schema had an issue,
  surfaced as `schema decode failed` on the frame (hover it for the reason).

## Known limitations (by design, for now)

- **Firefox isn't supported.** Firefox extensions have no equivalent to
  `chrome.debugger`/CDP, so a Firefox port would have to fall back to the same
  unreliable `devtools.network` approach the existing tools use — defeating
  the point. If you want a Firefox version later, it's doable, just strictly
  less reliable.
- **Compressed messages** (`grpc-encoding: gzip` etc.) are flagged but not
  decompressed — decoding needs the reported codec, not just the frame flag.
- **Custom proto3 extensions/options beyond `google/api/*`** (e.g.
  `buf/validate/validate.proto`, `protoc-gen-openapiv2` annotations) aren't
  specifically handled — if your schema depends on one for resolution to
  succeed, exclude that file from your selection the same way `google/api/*`
  is excluded automatically.

## How schema decoding works under the hood

protobuf.js compiles its encode/decode functions at runtime via
`new Function(...)`, which counts as `eval` — something a normal extension
page's Content Security Policy (`script-src 'self'`) flatly disallows in
Manifest V3, with no way to opt back in via the manifest. So all actual
protobuf.js work (parsing `.proto` files, decoding messages) happens in a
**sandboxed page** (`sandbox.html`/`sandbox.js`, declared via manifest's
`sandbox` key), which gets its own relaxed CSP that permits `eval`. The
DevTools panel (`panel.js`) never touches `protobuf.js` directly — it talks
to the sandbox over `postMessage` instead.

## Publish to the Chrome Web Store

1. Zip the folder contents (not the folder itself) — `manifest.json` should
   be at the zip root.
2. Register a developer account at the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time $5 fee).
3. Upload the zip, fill in listing details, submit for review (usually a
   few days).
