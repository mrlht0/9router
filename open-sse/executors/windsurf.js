/**
 * WindsurfExecutor — Codeium Cascade API via Connect RPC + Protobuf
 *
 * RESEARCH (from @Coral5644 — issue #332):
 *   Token: sk-ws-01-... (103 chars) extracted from %APPDATA%/Windsurf/User/globalStorage/state.vscdb
 *   API:   server.codeium.com — Connect RPC (gRPC-web)
 *   Auth:  Bearer token in Authorization header
 *
 * INFERENCE FLOW (verified working by @Coral5644):
 *   1. Extract token from Windsurf's Chromium storage (DPAPI + AES-256-GCM)
 *   2. POST to server.codeium.com with Connect RPC framing
 *   3. Cascade API: StartCascade → StreamCascadeReactiveUpdates + SendUserCascadeMessage
 *   4. Response is streaming protobuf frames (not SSE/NDJSON)
 *
 * TODO (maintainer — needs Windsurf account + traffic capture to complete):
 *   [ ] Reverse-engineer Codeium protobuf schemas (request/response messages)
 *   [ ] Implement Connect RPC frame parsing (similar to cursor.js)
 *   [ ] Implement Cascade message format (StartCascade, SendUserCascadeMessage, etc.)
 *   [ ] Implement protobuf-to-SSE response transform
 *   [ ] Handle tool calls, thinking, and streaming responses
 *   [ ] Test with real Windsurf token
 *
 * REFERENCE: Cursor executor (cursor.js) uses similar Connect RPC pattern with
 * different protobuf schemas — can reuse the frame parsing + decompression logic.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const WINDSURF_STREAM_DEBUG = process.env.WINDSURF_STREAM_DEBUG === "1";
const debugLog = (...args) => {
  if (WINDSURF_STREAM_DEBUG) console.log(...args);
};

export class WindsurfExecutor extends BaseExecutor {
  constructor() {
    super("windsurf", PROVIDERS.windsurf);
  }

  // --- URL building ---

  buildUrl() {
    // Codeium Cascade API — Connect RPC endpoint
    // TODO: determine exact RPC path (likely /CascadeService/StartCascade or similar)
    return this.config.baseUrl;
  }

  // --- Header building ---

  buildHeaders(credentials, stream = true) {
    const token = credentials.apiKey || credentials.accessToken;
    if (!token) {
      throw new Error("Windsurf API key is required (sk-ws-01-... format)");
    }

    const headers = {
      "Content-Type": "application/connect+proto",
      Authorization: `Bearer ${token}`,
      ...this.config.headers,
    };

    if (stream) {
      headers["Accept"] = "application/connect+proto";
      headers["connect-protocol-version"] = "1";
    }

    return headers;
  }

  // --- Request transformation ---

  transformRequest(model, body, stream, credentials) {
    // TODO: translate OpenAI/Claude messages → Codeium Cascade protobuf format
    //
    // Based on Coral5644's research, the Cascade API expects:
    //   - StartCascade message with model, system_prompt, conversation history
    //   - SendUserCascadeMessage for each user turn
    //
    // For now, return body as-is — maintainer needs protobuf schema to transform

    debugLog(`[WINDSURF] transformRequest: model=${model}, stream=${stream}`);

    // Placeholder: send raw body wrapped in a simple structure
    // Real implementation must encode as protobuf using Codeium's schema
    return {
      model: model,
      messages: body.messages || [],
      stream: stream,
      // TODO: add required Cascade fields (user_id, session_id, etc.)
    };
  }

  // --- Error handling ---

  parseError(response, bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      const message =
        parsed?.error?.message ||
        parsed?.error?.details?.[0]?.debug?.details?.title ||
        bodyText;
      return { status: response.status, message };
    } catch {
      return { status: response.status, message: bodyText || `HTTP ${response.status}` };
    }
  }

  shouldRetry(status, urlIndex) {
    // Windsurf has a single API endpoint — no fallback URLs
    return false;
  }

  // --- Main execution ---

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials, stream);
    const transformedBody = this.transformRequest(model, body, stream, credentials);

    try {
      const response = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal,
        },
        proxyOptions
      );

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const { message } = this.parseError(response, bodyText);

        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: `Windsurf API error [${response.status}]: ${message}`,
                type: response.status === 429 ? "rate_limit_error" : "api_error",
                code: String(response.status),
              },
            }),
            {
              status: response.status,
              headers: { "Content-Type": "application/json" },
            }
          ),
          url,
          headers,
          transformedBody,
        };
      }

      // TODO: transform Connect RPC protobuf response to SSE/JSON
      // The real response is a stream of protobuf frames containing:
      //   - text deltas (CascadeReactiveUpdate)
      //   - tool calls
      //   - thinking blocks
      //   - final stop reason
      //
      // For streaming: transform each protobuf frame → SSE data: {...}\n\n
      // For non-streaming: collect all frames → single JSON chat completion
      //
      // The raw response body IS the Connect RPC stream — pass it through
      // to the streaming handler which will parse frames.

      return { response, url, headers, transformedBody };
    } catch (error) {
      if (error.name === "AbortError") throw error;

      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: `Windsurf connection error: ${error.message}`,
              type: "connection_error",
              code: "",
            },
          }),
          {
            status: HTTP_STATUS.SERVER_ERROR,
            headers: { "Content-Type": "application/json" },
          }
        ),
        url,
        headers,
        transformedBody,
      };
    }
  }

  // --- Token management ---

  async refreshCredentials() {
    // Windsurf token (sk-ws-01-...) doesn't auto-refresh via OAuth
    // User must re-extract from Windsurf app when token expires
    return null;
  }

  needsRefresh(credentials) {
    // Windsurf tokens don't have expiresAt — user handles manually
    return false;
  }
}

export default WindsurfExecutor;