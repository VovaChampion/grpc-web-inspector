// Schema-less gRPC-Web frame decoder + generic protobuf wire-format walker.
//
// gRPC-Web frame format (per message on the wire):
//   [1 byte flags][4 byte big-endian length][payload...]
// flags & 0x80 -> this is a trailer frame (headers-style text, not a message)
// flags & 0x01 -> payload is compressed (we can't decode compressed payloads
//                 without knowing the codec, so we surface raw bytes instead)
//
// This only needs the *already reassembled* response body (as returned by
// CDP's Network.getResponseBody), so chunk-boundary issues that plague
// listener-based extensions don't apply here.

const GrpcWebDecoder = (function () {
  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function parseFrames(bytes) {
    const frames = [];
    let offset = 0;

    while (offset < bytes.length) {
      if (offset + 5 > bytes.length) {
        frames.push({
          type: "error",
          message: `Incomplete frame header at byte ${offset} (${bytes.length - offset} bytes left)`,
        });
        break;
      }

      const flag = bytes[offset];
      const length =
        (bytes[offset + 1] << 24) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 8) |
        bytes[offset + 4];
      offset += 5;

      if (length < 0 || offset + length > bytes.length) {
        frames.push({
          type: "error",
          message: `Frame at byte ${offset - 5} declares length ${length}, but only ${bytes.length - offset} bytes remain`,
        });
        break;
      }

      const payload = bytes.subarray(offset, offset + length);
      offset += length;
      const isTrailer = (flag & 0x80) !== 0;
      const compressed = (flag & 0x01) !== 0;

      if (isTrailer) {
        const text = new TextDecoder().decode(payload);
        const trailers = {};
        text.split("\r\n").forEach((line) => {
          const idx = line.indexOf(":");
          if (idx > 0) {
            trailers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
        });
        frames.push({ type: "trailer", raw: text, trailers, flag });
      } else {
        let decoded = null;
        let decodeError = null;
        if (compressed) {
          decodeError = "Compressed message payload — decode requires knowing the grpc-encoding codec (not attempted)";
        } else {
          try {
            decoded = decodeProtobufWire(payload);
          } catch (e) {
            decodeError = e.message;
          }
        }
        frames.push({
          type: "message",
          compressed,
          byteLength: payload.length,
          bytesBase64: bytesToBase64(payload),
          decoded,
          decodeError,
        });
      }
    }

    return frames;
  }

  // Walks raw protobuf wire format without a .proto schema. Field names are
  // unknown, so fields are keyed by number; length-delimited values are
  // speculatively offered as string / nested-message / raw bytes since the
  // wire format alone can't disambiguate them.
  function decodeProtobufWire(bytes) {
    const fields = [];
    let offset = 0;

    function readVarint() {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (offset >= bytes.length) throw new Error("Unexpected end of buffer while reading varint");
        const b = bytes[offset++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
        if (shift > 70n) throw new Error("Varint too long");
      }
      return result;
    }

    while (offset < bytes.length) {
      const tag = readVarint();
      const fieldNumber = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNumber === 0) throw new Error("Encountered field number 0 (not valid protobuf)");

      let value;
      switch (wireType) {
        case 0: {
          const v = readVarint();
          value = { kind: "varint", value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString() };
          break;
        }
        case 1: {
          if (offset + 8 > bytes.length) throw new Error("Unexpected end reading fixed64");
          const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
          value = { kind: "fixed64", double: dv.getFloat64(0, true), uint64: dv.getBigUint64(0, true).toString() };
          offset += 8;
          break;
        }
        case 2: {
          const len = Number(readVarint());
          if (offset + len > bytes.length) throw new Error("Unexpected end reading length-delimited field");
          const slice = bytes.subarray(offset, offset + len);
          offset += len;

          let asString = null;
          try {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(slice);
            // heuristic: only offer it as a string if it's printable
            if (/^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/.test(decoded)) asString = decoded;
          } catch (e) {
            /* not valid utf-8 */
          }

          let asMessage = null;
          try {
            asMessage = decodeProtobufWire(slice);
          } catch (e) {
            /* not a nested message */
          }

          value = {
            kind: "bytes",
            byteLength: slice.length,
            asString,
            asMessage,
            bytesBase64: bytesToBase64(slice),
          };
          break;
        }
        case 5: {
          if (offset + 4 > bytes.length) throw new Error("Unexpected end reading fixed32");
          const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
          value = { kind: "fixed32", float: dv.getFloat32(0, true), uint32: dv.getUint32(0, true) };
          offset += 4;
          break;
        }
        default:
          throw new Error(`Unsupported wire type ${wireType} (field ${fieldNumber})`);
      }

      fields.push({ fieldNumber, wireType, value });
    }

    return fields;
  }

  return { parseFrames, decodeProtobufWire };
})();

if (typeof self !== "undefined") self.GrpcWebDecoder = GrpcWebDecoder;
