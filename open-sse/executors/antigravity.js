import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, ANTIGRAVITY_HEADERS, INTERNAL_REQUEST_HEADER, AG_DEFAULT_TOOLS, AG_TOOL_SUFFIX } from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { deriveSessionId } from "../utils/sessionManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { cleanJSONSchemaForAntigravity } from "../translator/helpers/geminiHelper.js";

// Sanitize function name: Gemini requires [a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}
function sanitizeFunctionName(name) {
  if (!name) return "_unknown";
  let s = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.substring(0, 64);
}

const MAX_RETRY_AFTER_MS = 10000;
const MAX_ANTIGRAVITY_OUTPUT_TOKENS = 16384;
const ANTIGRAVITY_PARSED_ERROR_STATUSES = new Set([
  HTTP_STATUS.RATE_LIMITED,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  529
]);
const DURATION_TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?=\d|$|[^a-zA-Z])/gi;
const DURATION_FRAGMENT = "((?:\\d+(?:\\.\\d+)?\\s*(?:milliseconds?|msecs?|ms|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\\s*){1,4})";

function parseDurationMs(value, { plainSeconds = false } = {}) {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!text) return null;

  if (plainSeconds && /^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  }

  let totalMs = 0;
  let matched = false;
  const re = new RegExp(DURATION_TOKEN_PATTERN.source, "gi");
  let match;
  while ((match = re.exec(text)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = match[2].toLowerCase();
    if (unit.startsWith("ms") || unit.startsWith("millisecond") || unit.startsWith("msec")) totalMs += amount;
    else if (unit.startsWith("h")) totalMs += amount * 60 * 60 * 1000;
    else if (unit.startsWith("m")) totalMs += amount * 60 * 1000;
    else if (unit.startsWith("s")) totalMs += amount * 1000;
  }

  return matched && totalMs > 0 ? Math.round(totalMs) : null;
}

function futureDateMs(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : null;
}

function parseRetryAfterValue(value, now = Date.now()) {
  const durationMs = parseDurationMs(value, { plainSeconds: true });
  if (durationMs) return { retryAfterMs: durationMs, resetsAtMs: now + durationMs };

  const resetsAtMs = futureDateMs(value, now);
  return resetsAtMs ? { retryAfterMs: resetsAtMs - now, resetsAtMs } : {};
}

function parseResetAtValue(value, now = Date.now()) {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!text) return {};

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    const resetsAtMs = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : null;
    if (resetsAtMs && resetsAtMs > now) return { retryAfterMs: resetsAtMs - now, resetsAtMs };
  }

  const resetsAtMs = futureDateMs(text, now);
  return resetsAtMs ? { retryAfterMs: resetsAtMs - now, resetsAtMs } : {};
}

function extractAntigravityErrorMessage(bodyText) {
  const raw = typeof bodyText === "string" ? bodyText.trim() : "";
  if (!raw) return "";

  try {
    const json = JSON.parse(raw);
    const error = json?.error;
    const candidates = [
      typeof error?.message === "string" ? error.message : null,
      typeof json?.message === "string" ? json.message : null,
      typeof error === "string" ? error : null,
      typeof json?.error_description === "string" ? json.error_description : null,
      typeof error?.status === "string" ? error.status : null,
      typeof error?.code === "string" ? error.code : null,
    ];
    const message = candidates.find(v => v && v.trim());
    if (message) return message;
    return JSON.stringify(json);
  } catch {
    return raw;
  }
}

function parseRetryMsFromMessage(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return null;

  const patterns = [
    new RegExp(`\\b(?:reset|resets|resetting)\\s+(?:after|in)\\s+${DURATION_FRAGMENT}`, "i"),
    new RegExp(`\\b(?:retry|try again|available|resume)\\s+(?:after|in)\\s+${DURATION_FRAGMENT}`, "i"),
    new RegExp(`\\b(?:quota|rate limit|usage limit)[^.!?]{0,120}?\\b(?:after|in)\\s+${DURATION_FRAGMENT}`, "i"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const durationText = match[match.length - 1];
      const parsed = parseDurationMs(durationText);
      if (parsed) return parsed;
    }
  }

  if (new RegExp(`^${DURATION_FRAGMENT}$`, "i").test(text)) {
    return parseDurationMs(text);
  }

  return null;
}

function parseAntigravityRetryTiming(headers, bodyText = "", now = Date.now()) {
  const timing = { retryAfterMs: null, resetsAtMs: null };
  const getHeader = (name) => headers?.get?.(name) || null;

  const retryAfter = getHeader("retry-after");
  if (retryAfter) {
    const parsed = parseRetryAfterValue(retryAfter, now);
    timing.retryAfterMs = parsed.retryAfterMs ?? timing.retryAfterMs;
    timing.resetsAtMs = parsed.resetsAtMs ?? timing.resetsAtMs;
  }

  const resetAfter = getHeader("x-ratelimit-reset-after");
  if (resetAfter) {
    const resetAfterMs = parseDurationMs(resetAfter, { plainSeconds: true });
    if (resetAfterMs) {
      timing.retryAfterMs ??= resetAfterMs;
      timing.resetsAtMs ??= now + resetAfterMs;
    }
  }

  const reset = getHeader("x-ratelimit-reset");
  if (reset) {
    const parsed = parseResetAtValue(reset, now);
    timing.resetsAtMs = parsed.resetsAtMs ?? timing.resetsAtMs;
    timing.retryAfterMs ??= parsed.retryAfterMs ?? null;
  }

  const messageRetryMs = parseRetryMsFromMessage(extractAntigravityErrorMessage(bodyText));
  if (messageRetryMs) {
    timing.retryAfterMs ??= messageRetryMs;
    const messageResetsAtMs = now + messageRetryMs;
    if (!timing.resetsAtMs || messageResetsAtMs > timing.resetsAtMs) {
      timing.resetsAtMs = messageResetsAtMs;
    }
  }

  if (timing.resetsAtMs && timing.resetsAtMs <= now) timing.resetsAtMs = null;
  if (timing.retryAfterMs && timing.retryAfterMs <= 0) timing.retryAfterMs = null;
  if (!timing.retryAfterMs && timing.resetsAtMs) timing.retryAfterMs = timing.resetsAtMs - now;
  if (!timing.resetsAtMs && timing.retryAfterMs) timing.resetsAtMs = now + timing.retryAfterMs;

  return timing;
}

function classifyAntigravityError(status, message, retryAfterMs, resetsAtMs, now = Date.now()) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  const waitMs = resetsAtMs && resetsAtMs > now ? resetsAtMs - now : retryAfterMs;

  if (status === HTTP_STATUS.SERVICE_UNAVAILABLE || status === 529) {
    return "model_capacity";
  }

  if (status === HTTP_STATUS.RATE_LIMITED) {
    const strongQuota = /\b(quota|usage\s+limit|resource[_\s-]*exhausted|limit\s+reached|exhausted)\b/i.test(text);
    if (waitMs && waitMs > MAX_RETRY_AFTER_MS) return "quota_exhausted";
    if (waitMs && waitMs > 0) return "rate_limit";
    return strongQuota ? "quota_exhausted" : "rate_limit_unknown";
  }

  return "upstream_error";
}

function parseGoogleOAuthErrorBody(errorText) {
  const raw = typeof errorText === "string" ? errorText : "";
  const trimmed = raw.trim();
  let body = null;

  if (trimmed) {
    try {
      body = JSON.parse(trimmed);
    } catch {
      try {
        body = Object.fromEntries(new URLSearchParams(trimmed));
      } catch {}
    }
  }

  const errorValue = body?.error;
  const textCode = trimmed.match(/\b(invalid_grant|invalid_request|invalid_client|unauthorized_client|server_error|temporarily_unavailable)\b/i)?.[1]?.toLowerCase();
  const code = (
    (typeof errorValue === "string" && errorValue) ||
    (typeof errorValue?.code === "string" && errorValue.code) ||
    (typeof body?.error_code === "string" && body.error_code) ||
    (typeof body?.code === "string" && body.code) ||
    textCode ||
    null
  );
  const message = (
    (typeof body?.error_description === "string" && body.error_description) ||
    (typeof errorValue?.message === "string" && errorValue.message) ||
    (typeof body?.error_message === "string" && body.error_message) ||
    (typeof body?.message === "string" && body.message) ||
    trimmed ||
    null
  );

  return { code, message, raw };
}

function buildAntigravityRefreshFailure(response, errorText) {
  const parsed = parseGoogleOAuthErrorBody(errorText);
  const code = (parsed.code || `http_${response.status}`).toLowerCase();
  // #887: Google invalid_grant means reconnecting Antigravity is required; retries cannot recover.
  const permanent = code === "invalid_grant";
  const detail = parsed.message || `HTTP ${response.status}`;

  return {
    ok: false,
    permanent,
    reason: permanent ? "reauth_required" : code,
    code,
    message: permanent
      ? `Google OAuth refresh failed permanently (${code}): ${detail}. Reconnect Antigravity to re-authorize this account.`
      : `Google OAuth refresh failed (${code}): ${detail}`,
    provider: "antigravity",
    status: response.status,
    statusText: response.statusText,
    raw: parsed.raw,
  };
}

export class AntigravityExecutor extends BaseExecutor {
  constructor() {
    super("antigravity", PROVIDERS.antigravity);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0];
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${baseUrl}/v1internal:${action}`;
  }

  buildHeaders(credentials, stream = true, sessionId = null) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "User-Agent": this.config.headers?.["User-Agent"] || ANTIGRAVITY_HEADERS["User-Agent"],
      [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value,
      ...(sessionId && { "X-Machine-Session-Id": sessionId }),
      "Accept": stream ? "text/event-stream" : "application/json"
    };
  }

  transformRequest(model, body, stream, credentials) {
    const projectId = credentials?.projectId || this.generateProjectId();

    // Fix contents for Claude models via Antigravity
    const contents = body.request?.contents?.map(c => {
      let role = c.role;
      // functionResponse must be role "user" for Claude models
      if (c.parts?.some(p => p.functionResponse)) {
        role = "user";
      }
      // Strip thought-only parts, keep thoughtSignature on functionCall parts (Gemini 3+ requires it)
      const parts = c.parts?.filter(p => {
        if (p.thought && !p.functionCall) return false;
        if (p.thoughtSignature && !p.functionCall && !p.text) return false;
        return true;
      });
      if (role !== c.role || parts?.length !== c.parts?.length) {
        return { ...c, role, parts };
      }
      return c;
    });

    // Sanitize tool schemas and function names before sending to Antigravity.
    let tools = body.request?.tools;

    if (tools && tools.length > 0) {
      // Merge all groups into a single functionDeclarations group (Gemini expects 1 group)
      const allDeclarations = tools.flatMap(group =>
        (group.functionDeclarations || []).map(fn => ({
          ...fn,
          name: sanitizeFunctionName(fn.name),
          parameters: fn.parameters
            ? cleanJSONSchemaForAntigravity(structuredClone(fn.parameters))
            : { type: "object", properties: { reason: { type: "string", description: "Brief explanation" } }, required: ["reason"] }
        }))
      );
      tools = allDeclarations.length > 0 ? [{ functionDeclarations: allDeclarations }] : [];
    }

    const { tools: _originalTools, toolConfig: _originalToolConfig, ...requestWithoutTools } = body.request || {};
    const generationConfig = { ...(requestWithoutTools.generationConfig || {}) };
    if (generationConfig.maxOutputTokens > MAX_ANTIGRAVITY_OUTPUT_TOKENS) {
      generationConfig.maxOutputTokens = MAX_ANTIGRAVITY_OUTPUT_TOKENS;
    }

    const transformedRequest = {
      ...requestWithoutTools,
      generationConfig,
      ...(contents && { contents }),
      ...(tools && { tools }),
      sessionId: body.request?.sessionId || deriveSessionId(credentials?.email || credentials?.connectionId),
      safetySettings: undefined,
      ...(tools?.length > 0 && { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } })
    };

    return {
      ...body,
      project: projectId,
      model: model,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent-${crypto.randomUUID()}`,
      request: transformedRequest
    };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        })
      }, proxyOptions);

      if (!response.ok) {
        const errorText = await response.text();
        const failure = buildAntigravityRefreshFailure(response, errorText);
        log?.error?.("TOKEN", failure.message, {
          status: failure.status,
          code: failure.code,
          permanent: failure.permanent,
          error: failure.raw,
        });
        return failure;
      }

      const tokens = await response.json();
      log?.info?.("TOKEN", "Antigravity refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId: credentials.projectId
      };
    } catch (error) {
      log?.error?.("TOKEN", `Antigravity refresh error: ${error.message}`);
      return null;
    }
  }

  generateProjectId() {
    const adj = ["useful", "bright", "swift", "calm", "bold"][Math.floor(Math.random() * 5)];
    const noun = ["fuze", "wave", "spark", "flow", "core"][Math.floor(Math.random() * 5)];
    return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
  }

  generateSessionId() {
    return crypto.randomUUID() + Date.now().toString();
  }

  parseRetryHeaders(headers) {
    if (!headers?.get) return null;

    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const { retryAfterMs } = parseRetryAfterValue(retryAfter);
      if (retryAfterMs) return retryAfterMs;
    }

    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (resetAfter) {
      const retryAfterMs = parseDurationMs(resetAfter, { plainSeconds: true });
      if (retryAfterMs) return retryAfterMs;
    }

    const resetTimestamp = headers.get('x-ratelimit-reset');
    if (resetTimestamp) {
      const { retryAfterMs } = parseResetAtValue(resetTimestamp);
      if (retryAfterMs) return retryAfterMs;
    }

    return null;
  }

  // Parse retry time from Antigravity error message body
  // Format: "Your quota will reset after 2h7m23s" or "1h30m" or "45m" or "30s"
  parseRetryFromErrorMessage(errorMessage) {
    if (!errorMessage || typeof errorMessage !== "string") return null;

    return parseRetryMsFromMessage(errorMessage);
  }

  parseError(response, bodyText) {
    if (!ANTIGRAVITY_PARSED_ERROR_STATUSES.has(response.status)) {
      return super.parseError(response, bodyText);
    }

    const now = Date.now();
    const message = extractAntigravityErrorMessage(bodyText) || `HTTP ${response.status}`;
    const { retryAfterMs, resetsAtMs } = parseAntigravityRetryTiming(response.headers, bodyText, now);
    const reason = classifyAntigravityError(response.status, message, retryAfterMs, resetsAtMs, now);

    return {
      status: response.status,
      message,
      reason,
      retryAfterMs,
      resetsAtMs,
      retryable: reason === "model_capacity" || reason === "rate_limit" || reason === "rate_limit_unknown"
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const MAX_AUTO_RETRIES = 3;
    const MAX_RETRY_AFTER_RETRIES = 3;
    const retryAttemptsByUrl = {}; // Track retry attempts per URL
    const retryAfterAttemptsByUrl = {}; // Track Retry-After retries per URL

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const sessionId = transformedBody.request?.sessionId;
      const headers = this.buildHeaders(credentials, stream, sessionId);

      // Initialize retry counters for this URL
      if (!retryAttemptsByUrl[urlIndex]) {
        retryAttemptsByUrl[urlIndex] = 0;
      }
      if (!retryAfterAttemptsByUrl[urlIndex]) {
        retryAfterAttemptsByUrl[urlIndex] = 0;
      }

      try {
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal
        }, proxyOptions);

        if (response.status === HTTP_STATUS.RATE_LIMITED || response.status === HTTP_STATUS.SERVICE_UNAVAILABLE) {
          // Try to get retry time from headers first
          let retryMs = this.parseRetryHeaders(response.headers);

          // If no retry time in headers, try to parse from error message body
          if (!retryMs) {
            try {
              const errorBody = await response.clone().text();
              retryMs = this.parseRetryFromErrorMessage(extractAntigravityErrorMessage(errorBody));
            } catch (e) {
              // Ignore parse errors, will fall back to exponential backoff
            }
          }

          if (retryMs && retryMs <= MAX_RETRY_AFTER_MS && retryAfterAttemptsByUrl[urlIndex] < MAX_RETRY_AFTER_RETRIES) {
            retryAfterAttemptsByUrl[urlIndex]++;
            log?.debug?.("RETRY", `${response.status} with Retry-After: ${Math.ceil(retryMs / 1000)}s, waiting... (${retryAfterAttemptsByUrl[urlIndex]}/${MAX_RETRY_AFTER_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, retryMs));
            urlIndex--;
            continue;
          }

          // Auto retry only for 429 when retryMs is 0 or undefined
          if (response.status === HTTP_STATUS.RATE_LIMITED && (!retryMs || retryMs === 0) && retryAttemptsByUrl[urlIndex] < MAX_AUTO_RETRIES) {
            retryAttemptsByUrl[urlIndex]++;
            // Exponential backoff: 2s, 4s, 8s...
            const backoffMs = Math.min(1000 * (2 ** retryAttemptsByUrl[urlIndex]), MAX_RETRY_AFTER_MS);
            log?.debug?.("RETRY", `429 auto retry ${retryAttemptsByUrl[urlIndex]}/${MAX_AUTO_RETRIES} after ${backoffMs / 1000}s`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            urlIndex--;
            continue;
          }

          log?.debug?.("RETRY", `${response.status}, Retry-After ${retryMs ? `too long (${Math.ceil(retryMs / 1000)}s)` : 'missing'}, trying fallback`);
          lastStatus = response.status;

          if (urlIndex + 1 < fallbackCount) {
            continue;
          }
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        lastError = error;
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }

  /**
   * Cloak tools before sending to Antigravity provider (anti-ban):
   * - Rename client tools with _ide suffix
   * - Inject AG default decoy tools after client tools
   * Returns { cloakedBody, toolNameMap } where toolNameMap maps suffixed → original
   */
  static cloakTools(body, clientTool = null) {
    const tools = body.request?.tools;
    if (!tools || tools.length === 0) {
      return { cloakedBody: body, toolNameMap: null };
    }

    const isCopilot = clientTool === "github-copilot";
    const toolNameMap = new Map();
    const clientDeclarations = [];
    const decoyNames = new Set(AG_DECOY_TOOLS.map(tool => tool.name));

    // First: collect renamed client tools
    for (const toolGroup of tools) {
      if (!toolGroup.functionDeclarations) continue;

      for (const func of toolGroup.functionDeclarations) {
        // For GitHub Copilot, avoid emitting duplicate native Antigravity tool names.
        // Keep the decoys only once in the final declaration list.
        if (isCopilot && AG_DEFAULT_TOOLS.has(func.name)) {
          continue;
        }

        // Skip if already covered by decoys for Copilot
        if (isCopilot && decoyNames.has(func.name)) {
          continue;
        }

        // Preserve native AG names for non-Copilot clients
        if (AG_DEFAULT_TOOLS.has(func.name)) {
          clientDeclarations.push(func);
          continue;
        }

        const suffixed = `${func.name}${AG_TOOL_SUFFIX}`;
        toolNameMap.set(suffixed, func.name);
        clientDeclarations.push({ ...func, name: suffixed });
      }
    }

    // Client tools first, then AG decoy tools
    const allDeclarations = [];
    const seenNames = new Set();
    for (const decl of [...clientDeclarations, ...AG_DECOY_TOOLS]) {
      if (!decl?.name || seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      allDeclarations.push(decl);
    }

    // Rename tool names in conversation history (contents)
    const cloakedContents = body.request?.contents?.map(msg => {
      if (!msg.parts) return msg;
      
      const cloakedParts = msg.parts.map(part => {
        // Rename functionCall.name
        if (part.functionCall && !AG_DEFAULT_TOOLS.has(part.functionCall.name)) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        // Rename functionResponse.name
        if (part.functionResponse && !AG_DEFAULT_TOOLS.has(part.functionResponse.name)) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        return part;
      });
      
      return { ...msg, parts: cloakedParts };
    });

    // Single functionDeclarations group: client tools first, then decoys
    return {
      cloakedBody: {
        ...body,
        request: {
          ...body.request,
          tools: [{ functionDeclarations: allDeclarations }],
          contents: cloakedContents || body.request.contents
        }
      },
      toolNameMap
    };
  }
}

// AG decoy tools — same names as AG native defaults, redirect to _ide suffixed tools
const AG_DECOY_TOOLS = [
  {
    name: "browser_subagent",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "command_status",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "find_by_name",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "generate_image",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "grep_search",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_dir",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_resources",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "mcp_sequential-thinking_sequentialthinking",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "multi_replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "notify_user",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_resource",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_terminal",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_url_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "run_command",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "search_web",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "send_command_input",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "task_boundary",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_content_chunk",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "write_to_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  }
];

export default AntigravityExecutor;
