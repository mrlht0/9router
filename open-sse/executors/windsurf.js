/**
 * WindsurfExecutor — Codeium GetChatMessage API via Connect RPC + Protobuf
 *
 * PROTOCOL (reverse-engineered from windsurf-tools/chat_proto.go):
 *   Endpoint: POST server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage
 *   Format:   Connect RPC v1 (application/proto), gzip-compressed protobuf body
 *   Auth:     Bearer sk-ws-01-...
 *
 * REQUEST layout:
 *   [5-byte envelope: 0x01 + 4B big-endian length] + gzip(protobuf_body)
 *   F1  = metadata {app, version, api_key, locale, OS, CPU, client_ver, timestamp, user_id, device_hash, flags, fp, team_id}
 *   F2  = system prompt (string)
 *   F3  = chat messages (repeated: {F2=role varint, F3=content, F4=index})
 *   F7  = settings varint (5)
 *   F8  = generation config
 *   F13 = flag bytes (0x08, 0x01)
 *   F15 = conversation context
 *   F16 = conversation UUID
 *   F20 = varint flag (1)
 *   F21 = model name
 *   F22 = message UUID
 *
 * RESPONSE layout (server-streaming):
 *   [5-byte envelopes]...
 *   flags & 0x01 = gzip payload, flags & 0x02 = end-of-stream trailer
 *   Each frame: F3=delta text, F4=sequence, F5=end-flag (non-zero = done)
 *
 * REFERENCE: github.com/seven7763/windsurf-tools/backend/services/chat_proto.go
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import zlib from "zlib";
import crypto from "crypto";

const debug = process.env.WINDSURF_STREAM_DEBUG === "1";

// ── Protobuf encoding utilities ──

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIM = 2;

/** Encode unsigned varint to bytes */
function encodeVarint(val) {
  const buf = [];
  while (val > 127) {
    buf.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  buf.push(val);
  return Buffer.from(buf);
}

/** Encode tag: (field_num << 3) | wire_type */
function encodeTag(num, wire) {
  return encodeVarint((num << 3) | wire);
}

/** Length-delimited field: tag + varint(len) + data */
function encodeBytesField(num, data) {
  const tag = encodeTag(num, WIRE_LENGTH_DELIM);
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

/** Varint field: tag + varint(value) */
function encodeVarintField(num, val) {
  return Buffer.concat([encodeTag(num, WIRE_VARINT), encodeVarint(val)]);
}

/** String field (wire type 2) */
function encodeStringField(num, str) {
  return encodeBytesField(num, Buffer.from(str, "utf-8"));
}

/** Encode a repeated sub-message as length-delimited */
function encodeSubMessage(num, msg) {
  return encodeBytesField(num, msg);
}

// ── Identity / fingerprint helpers ──

function generateUUID() {
  return crypto.randomUUID();
}

function deriveDeviceHash(apiKey) {
  return crypto.createHash("sha256").update("ws-device-" + apiKey).digest("hex");
}

function deriveUserId(apiKey) {
  const h = crypto.createHash("md5").update("ws-user-" + apiKey).digest("hex");
  return "user-" + h.substring(0, 12);
}

function deriveSessionId(apiKey) {
  return crypto.createHash("md5").update("ws-session-" + apiKey).digest("hex");
}

// ── Request builder ──

function buildOSPlatformJSON() {
  const osName = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || "linux";
  const arch = process.arch;
  return JSON.stringify({
    Os: osName,
    Arch: arch,
    Version: process.platform === "darwin" ? "15.0" : "6.0",
    ProductName: osName === "macos" ? "macOS" : osName,
    MajorVersionNumber: 15,
    MinorVersionNumber: 0,
    Build: "24A335",
  });
}

function buildCPUInfoJSON() {
  const cpus = require("os").cpus();
  return JSON.stringify({
    NumSockets: 1,
    NumCores: cpus.length,
    NumThreads: cpus.length,
    VendorID: "GenuineIntel",
    Family: "6",
    ModelName: cpus[0]?.model || "Unknown",
    Memory: Math.round(require("os").totalmem() / (1024 * 1024 * 1024)),
  });
}

/** Build metadata sub-message (F1) */
function buildMetadata(apiKey) {
  const now = Date.now();
  const unixSec = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;

  const deviceHash = deriveDeviceHash(apiKey);
  const userId = deriveUserId(apiKey);
  const sessionId = deriveSessionId(apiKey);

  // F16: timestamp {F1=unix_sec, F2=nanos}
  const tsMsg = Buffer.concat([
    encodeVarintField(1, unixSec),
    encodeVarintField(2, nanos),
  ]);

  return Buffer.concat([
    encodeStringField(1, "windsurf"),                         // F1  app name
    encodeStringField(2, "1.48.2"),                           // F2  version
    encodeStringField(3, apiKey),                             // F3  api key
    encodeStringField(4, "en"),                               // F4  locale
    encodeStringField(5, buildOSPlatformJSON()),              // F5  OS JSON
    encodeStringField(7, "2.0.50"),                           // F7  client version (STRING, not sub-msg!)
    encodeStringField(8, buildCPUInfoJSON()),                 // F8  CPU JSON
    encodeStringField(12, "windsurf"),                        // F12 app name (dup)
    encodeSubMessage(16, tsMsg),                              // F16 timestamp
    encodeStringField(20, userId),                            // F20 user ID
    encodeStringField(27, deviceHash),                        // F27 device hash
    encodeBytesField(30, Buffer.from([0x00, 0x01, 0x03])),   // F30 flag bytes
    encodeStringField(31, deviceHash.repeat(12).substring(0, 764)), // F31 long fp
    encodeStringField(32, sessionId),                         // F32 team/session ID
  ]);
}

/** Build generation config sub-message (F8) */
function buildGenerationConfig() {
  return Buffer.concat([encodeVarintField(1, 8192)]); // max_tokens
}

/** Build the full GetChatMessage protobuf request body */
function buildChatRequest(messages, model, apiKey, conversationId) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Messages array required");
  }

  // F1: metadata
  const body = [encodeSubMessage(1, buildMetadata(apiKey))];

  // F2: system prompt (extract from messages with role=system)
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  if (systemParts.length > 0) {
    body.push(encodeStringField(2, systemParts.join("\n\n")));
  }

  // F3: chat messages (non-system)
  const chatMsgs = messages.filter((m) => m.role !== "system");
  for (let i = 0; i < chatMsgs.length; i++) {
    const m = chatMsgs[i];
    const role = m.role === "assistant" ? 2 : 1;
    const msg = Buffer.concat([
      encodeVarintField(2, role),
      encodeStringField(3, typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
      encodeVarintField(4, i),
    ]);
    body.push(encodeSubMessage(3, msg));
  }

  // F7: settings varint
  body.push(encodeVarintField(7, 5));

  // F8: generation config
  body.push(encodeSubMessage(8, buildGenerationConfig()));

  // F13: flag sub-message
  body.push(encodeSubMessage(13, Buffer.from([0x08, 0x01])));

  // F15: conversation context (if continuing)
  if (conversationId) {
    const ctx = encodeStringField(1, conversationId);
    body.push(encodeSubMessage(15, ctx));
  }

  // F16: conversation UUID
  const convUuid = conversationId || generateUUID();
  body.push(encodeBytesField(16, Buffer.from(convUuid, "utf-8")));

  // F20: flag varint
  body.push(encodeVarintField(20, 1));

  // F21: model name
  if (model) {
    body.push(encodeStringField(21, model));
  }

  // F22: message UUID
  body.push(encodeStringField(22, generateUUID()));

  return Buffer.concat(body);
}

/** Wrap protobuf body in Connect RPC gzip envelope */
function wrapEnvelope(protoBody) {
  const compressed = zlib.gzipSync(protoBody);
  const envelope = Buffer.alloc(5 + compressed.length);
  envelope[0] = 0x01; // compressed flag
  envelope.writeUInt32BE(compressed.length, 1);
  compressed.copy(envelope, 5);
  return envelope;
}

// ── Response parser ──

/** Extract Connect RPC envelopes from response buffer */
function extractEnvelopes(buffer) {
  const envelopes = [];
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const flags = buffer[pos];
    const len = buffer.readUInt32BE(pos + 1);
    pos += 5;
    if (pos + len > buffer.length) break;
    envelopes.push({ flags, payload: buffer.slice(pos, pos + len) });
    pos += len;
  }
  return envelopes;
}

/** Decompress envelope payload if gzip flag is set */
function decompressPayload(flags, payload) {
  if (!(flags & 0x01)) return payload;
  try {
    return zlib.gunzipSync(payload);
  } catch {
    return payload;
  }
}

/** Parse a single Connect RPC frame to extract text delta */
function parseFrameChunk(data) {
  let text = "";
  let isDone = false;
  let pos = 0;

  while (pos < data.length) {
    // Read tag
    let tag = 0;
    let shift = 0;
    while (pos < data.length) {
      const b = data[pos++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === WIRE_VARINT) {
      let val = 0;
      shift = 0;
      while (pos < data.length) {
        const b = data[pos++];
        val |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      // F5: end-flag (non-zero = done)
      if (fieldNum === 5 && val !== 0) isDone = true;
      // Legacy: F2 varint end-flag
      if (fieldNum === 2 && val !== 0) isDone = true;
    } else if (wireType === WIRE_LENGTH_DELIM) {
      let len = 0;
      shift = 0;
      while (pos < data.length) {
        const b = data[pos++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      const bytes = data.slice(pos, pos + len);
      pos += len;

      // F3: text delta (top-level string)
      if (fieldNum === 3) {
        try {
          const s = bytes.toString("utf-8");
          if (s.length > 0 && !s.startsWith("bot-") && s.length !== 36) {
            text += s;
          }
        } catch {}
      }
    } else if (wireType === 1) {
      pos += 8; // fixed64 — skip
    } else {
      break; // unknown wire type
    }
  }

  return { text, isDone };
}

// ── Executor ──

export class WindsurfExecutor extends BaseExecutor {
  constructor() {
    super("windsurf", PROVIDERS.windsurf);
  }

  buildUrl() {
    return "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage";
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials.apiKey || credentials.accessToken;
    if (!token) throw new Error("Windsurf API key required (sk-ws-01-...)");

    return {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      Authorization: `Bearer ${token}`,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (debug) console.log(`[WINDSURF] model=${model}, msgs=${body.messages?.length || 0}, stream=${stream}`);

    const apiKey = credentials.apiKey || credentials.accessToken;
    const convId = credentials.providerSpecificData?.conversationId || "";
    const protoBody = buildChatRequest(body.messages, model, apiKey, convId);
    return wrapEnvelope(protoBody);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials, stream);
    const rawBody = this.transformRequest(model, body, stream, credentials);

    try {
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: rawBody,
        signal,
      }, proxyOptions);

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const status = response.status;
        return {
          response: new Response(JSON.stringify({
            error: {
              message: `Windsurf [${status}]: ${bodyText.slice(0, 300)}`,
              type: status === 429 ? "rate_limit_error" : "api_error",
              code: String(status),
            },
          }), { status, headers: { "Content-Type": "application/json" } }),
          url, headers, transformedBody: rawBody,
        };
      }

      // Read full response buffer
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      if (debug) console.log(`[WINDSURF] Response: ${buf.length} bytes`);

      // Non-streaming: collect all frames into single JSON
      if (!stream) {
        const transformed = this._transformToJSON(buf, model, body);
        return { response: transformed, url, headers, transformedBody: rawBody };
      }

      // Streaming: transform to SSE
      const sseResponse = this._transformToSSE(buf, model, body);
      return { response: sseResponse, url, headers, transformedBody: rawBody };
    } catch (error) {
      if (error.name === "AbortError") throw error;
      return {
        response: new Response(JSON.stringify({
          error: { message: `Windsurf connection: ${error.message}`, type: "connection_error", code: "" },
        }), { status: HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
        url, headers, transformedBody: rawBody,
      };
    }
  }

  _transformToJSON(buf, model, body) {
    const responseId = `chatcmpl-ws-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let totalContent = "";

    const envelopes = extractEnvelopes(buf);
    for (const env of envelopes) {
      if (env.flags & 0x02) continue; // end-stream trailer
      const frame = decompressPayload(env.flags, env.payload);
      const { text } = parseFrameChunk(frame);
      totalContent += text;
    }

    const completion = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: totalContent || "" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  _transformToSSE(buf, model, body) {
    const responseId = `chatcmpl-ws-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunks = [];
    let totalContent = "";

    const envelopes = extractEnvelopes(buf);
    let firstDelta = true;

    for (const env of envelopes) {
      if (env.flags & 0x02) continue;
      const frame = decompressPayload(env.flags, env.payload);
      const { text, isDone } = parseFrameChunk(frame);

      if (text) {
        totalContent += text;
        const delta = firstDelta
          ? { role: "assistant", content: text }
          : { content: text };
        firstDelta = false;

        chunks.push(`data: ${JSON.stringify({
          id: responseId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      }

      if (isDone) break;
    }

    // If no content generated, send empty delta
    if (chunks.length === 0) {
      chunks.push(`data: ${JSON.stringify({
        id: responseId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`);
    }

    // Final chunk with finish_reason
    chunks.push(`data: ${JSON.stringify({
      id: responseId, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })}\n\n`);
    chunks.push("data: [DONE]\n\n");

    return new Response(chunks.join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default WindsurfExecutor;