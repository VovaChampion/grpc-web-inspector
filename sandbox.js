// Runs inside a sandboxed extension page (see manifest.json's "sandbox" key).
// protobuf.js compiles its encode/decode/toObject functions at runtime via
// `new Function(...)`, which a normal MV3 extension page's CSP (script-src
// 'self') blocks as unsafe-eval. Sandboxed pages get their own relaxed CSP
// that allows it, so all actual protobuf.js work happens here — panel.js
// talks to this page over postMessage instead of calling protobuf.js itself.

let protoRoot = null;

// protobuf.js resolves "google/protobuf/*.proto" imports (Duration, Any,
// Timestamp, etc.) out of the box, but NOT the separate "google/type/*.proto"
// package (DateTime, Money, Date, ...) — yet those show up constantly in real
// APIs. So: parse every selected file into one shared Root, plus these
// bundled sources, so cross-file type references resolve without needing
// real file-path import fetching.
const GOOGLE_TYPE_PROTOS = {
  // protobuf.js only auto-resolves "google/protobuf/*.proto" imports when
  // fetched via protobuf.load() (which does real file I/O); plain parse()
  // calls like ours never touch that lookup, so DateTime's own dependency on
  // Duration has to be bundled too rather than left to protobuf.js "magic".
  "duration.proto": `
    syntax = "proto3";
    package google.protobuf;
    message Duration {
      int64 seconds = 1;
      int32 nanos = 2;
    }
  `,
  "datetime.proto": `
    syntax = "proto3";
    package google.type;
    import "google/protobuf/duration.proto";
    message DateTime {
      int32 year = 1;
      int32 month = 2;
      int32 day = 3;
      int32 hours = 4;
      int32 minutes = 5;
      int32 seconds = 6;
      int32 nanos = 7;
      oneof time_offset {
        google.protobuf.Duration utc_offset = 8;
        TimeZone time_zone = 9;
      }
    }
    message TimeZone {
      string id = 1;
      string version = 2;
    }
  `,
  "date.proto": `
    syntax = "proto3";
    package google.type;
    message Date {
      int32 year = 1;
      int32 month = 2;
      int32 day = 3;
    }
  `,
  "timeofday.proto": `
    syntax = "proto3";
    package google.type;
    message TimeOfDay {
      int32 hours = 1;
      int32 minutes = 2;
      int32 seconds = 3;
      int32 nanos = 4;
    }
  `,
  "dayofweek.proto": `
    syntax = "proto3";
    package google.type;
    enum DayOfWeek {
      DAY_OF_WEEK_UNSPECIFIED = 0;
      MONDAY = 1;
      TUESDAY = 2;
      WEDNESDAY = 3;
      THURSDAY = 4;
      FRIDAY = 5;
      SATURDAY = 6;
      SUNDAY = 7;
    }
  `,
  "latlng.proto": `
    syntax = "proto3";
    package google.type;
    message LatLng {
      double latitude = 1;
      double longitude = 2;
    }
  `,
  "money.proto": `
    syntax = "proto3";
    package google.type;
    message Money {
      string currency_code = 1;
      int64 units = 2;
      int32 nanos = 3;
    }
  `,
  // The rest of protobuf.js's own "common" well-known types (mirrors
  // src/common.js) — also not auto-resolved by plain parse(), and just as
  // likely to turn up as actual message field types (unlike google/api/*,
  // which only appears in method *options* and needs the much larger
  // google/protobuf/descriptor.proto we don't bundle).
  "any.proto": `
    syntax = "proto3";
    package google.protobuf;
    message Any {
      string type_url = 1;
      bytes value = 2;
    }
  `,
  "timestamp.proto": `
    syntax = "proto3";
    package google.protobuf;
    message Timestamp {
      int64 seconds = 1;
      int32 nanos = 2;
    }
  `,
  "empty.proto": `
    syntax = "proto3";
    package google.protobuf;
    message Empty {}
  `,
  "struct.proto": `
    syntax = "proto3";
    package google.protobuf;
    message Struct {
      map<string, Value> fields = 1;
    }
    message Value {
      oneof kind {
        NullValue null_value = 1;
        double number_value = 2;
        string string_value = 3;
        bool bool_value = 4;
        Struct struct_value = 5;
        ListValue list_value = 6;
      }
    }
    enum NullValue {
      NULL_VALUE = 0;
    }
    message ListValue {
      repeated Value values = 1;
    }
  `,
  "wrappers.proto": `
    syntax = "proto3";
    package google.protobuf;
    message DoubleValue { double value = 1; }
    message FloatValue { float value = 1; }
    message Int64Value { int64 value = 1; }
    message UInt64Value { uint64 value = 1; }
    message Int32Value { int32 value = 1; }
    message UInt32Value { uint32 value = 1; }
    message BoolValue { bool value = 1; }
    message StringValue { string value = 1; }
    message BytesValue { bytes value = 1; }
  `,
  "field_mask.proto": `
    syntax = "proto3";
    package google.protobuf;
    message FieldMask {
      repeated string paths = 1;
    }
  `,
};

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

// gRPC-Web call URLs look like https://host/package.Service/MethodName —
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

function loadSchema(files) {
  const root = new protobuf.Root();
  const userFileNames = new Set(files.map((f) => f.name.toLowerCase()));

  // bundled well-known-type defs first, skipped if the user supplied their
  // own copy under the same filename
  for (const [name, source] of Object.entries(GOOGLE_TYPE_PROTOS)) {
    if (userFileNames.has(name)) continue;
    protobuf.parse(source, root, { keepCase: true });
  }

  for (const file of files) {
    try {
      protobuf.parse(file.text, root, { keepCase: true });
    } catch (e) {
      throw new Error(`${file.relPath || file.name}: ${e.message}`);
    }
  }

  root.resolveAll();
  protoRoot = root;
  return {
    serviceCount: countNested(protoRoot, (obj) => obj instanceof protobuf.Service),
    messageCount: countNested(protoRoot, (obj) => obj instanceof protobuf.Type),
  };
}

function decodeMessage(url, direction, bytesBase64) {
  const info = resolveMethodForUrl(url);
  if (!info) return { hasType: false };
  const type = direction === "request" ? info.requestType : info.responseType;
  if (!type) return { hasType: false };
  const typeFullName = type.fullName.replace(/^\./, "");
  try {
    const bytes = base64ToBytes(bytesBase64);
    const message = type.decode(bytes);
    const value = type.toObject(message, {
      longs: "string",
      enums: "string",
      bytes: "base64",
      defaults: false,
    });
    return { hasType: true, value, typeFullName };
  } catch (e) {
    return { hasType: true, error: e.message, typeFullName };
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || msg.id === undefined || !msg.cmd) return;
  const reply = (payload) => {
    (event.source || window.parent).postMessage(Object.assign({ id: msg.id }, payload), "*");
  };
  try {
    switch (msg.cmd) {
      case "loadSchema":
        reply({ ok: true, result: loadSchema(msg.files) });
        break;
      case "resolveMethod": {
        const info = resolveMethodForUrl(msg.url);
        if (!protoRoot) reply({ ok: true, result: { loaded: false } });
        else if (!info) reply({ ok: true, result: { loaded: true, matched: false } });
        else
          reply({
            ok: true,
            result: { loaded: true, matched: true, serviceName: info.serviceName, methodName: info.methodName },
          });
        break;
      }
      case "decode":
        reply({ ok: true, result: decodeMessage(msg.url, msg.direction, msg.bytesBase64) });
        break;
      default:
        reply({ ok: false, error: "Unknown sandbox command: " + msg.cmd });
    }
  } catch (e) {
    reply({ ok: false, error: e.message });
  }
});

window.parent.postMessage({ type: "sandbox-ready" }, "*");
