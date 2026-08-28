# gRPC-Web Inspector

A DevTools panel for inspecting gRPC-Web traffic, built on the **Chrome DevTools
Protocol** (`chrome.debugger`) instead of the public `devtools.network` API.

## Why this is more stable than the existing extensions

The gRPC-Web extensions you tried both use `chrome.devtools.network.onRequestFinished`
and `request.getContent()`, which is unreliable for binary and streamed bodies —
that's almost certainly the "works sometimes" behavior you saw. This extension
instead:

1. Attaches via `chrome.debugger` and listens to raw CDP `Network.*` events.
2. Waits for `Network.loadingFinished`, then calls `Network.getResponseBody`,
   which returns the **fully reassembled** response body (Chrome does the
   chunk reassembly internally) — so streaming responses and binary payloads
   come through intact rather than split mid-frame.
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

## Known limitations (by design, for now)

- **Firefox isn't supported.** Firefox extensions have no equivalent to
  `chrome.debugger`/CDP, so a Firefox port would have to fall back to the same
  unreliable `devtools.network` approach the existing tools use — defeating
  the point. If you want a Firefox version later, it's doable, just strictly
  less reliable.
- **Request bodies aren't decoded yet** — only responses. CDP's request-body
  APIs are text-oriented and can mangle binary payloads; doing this properly
  needs a bit more care (buffering via `Network.requestWillBeSentExtraInfo` /
  intercepting via `Fetch.enable`) which is a good next step.
- **Compressed messages** (`grpc-encoding: gzip` etc.) are flagged but not
  decompressed — decoding needs the reported codec, not just the frame flag.
- **No `.proto` upload yet.** Right now fields are labeled by number only.
  Adding `protobufjs` + a "load .proto" button would let you see real field
  names — natural next step if this proves useful.

## Publish to the Chrome Web Store

1. Zip the folder contents (not the folder itself) — `manifest.json` should
   be at the zip root.
2. Register a developer account at the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time $5 fee).
3. Upload the zip, fill in listing details, submit for review (usually a
   few days).
