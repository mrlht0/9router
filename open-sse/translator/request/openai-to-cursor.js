/**
 * OpenAI to Cursor Request Translator
 * Converts OpenAI messages to Cursor ask/agent format.
 *
 * Important: Cursor can loop when tool outputs are sent via protobuf tool_results
 * with partial schema mismatches. For stability, tool outputs are represented as
 * structured text blocks in user messages.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => {
        if (!part || typeof part !== "object") return false;
        return part.type === "text" && typeof part.text === "string";
      })
      .map(part => part.text || "")
      .join("");
  }
  return "";
}

function sanitizeToolResultText(text) {
  // Strip non-printable control chars that can produce backend request errors
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildToolResultBlock(toolName, toolCallId, resultText) {
  const cleanResult = sanitizeToolResultText(resultText || "");
  return [
    "<tool_result>",
    `<tool_name>${escapeXml(toolName || "tool")}</tool_name>`,
    `<tool_call_id>${escapeXml(toolCallId || "")}</tool_call_id>`,
    `<result>${escapeXml(cleanResult)}</result>`,
    "</tool_result>"
  ].join("\n");
}

function normalizeToolCallId(id) {
  return typeof id === "string" ? id.split("\n")[0] : "";
}

function collectUserText(messages) {
  return (messages || [])
    .filter(msg => msg?.role === "user")
    .map(msg => extractContent(msg?.content))
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function normalizeToolName(rawName) {
  if (typeof rawName !== "string") return "";
  if (rawName.startsWith("mcp__")) return rawName.slice("mcp__".length).replace(/__/g, " ");
  return rawName.replace(/_/g, " ");
}

function isLowSignalToken(token) {
  return token.length < 3 || ["the", "and", "for", "with", "tool", "tools", "mcp", "use"].includes(token);
}

function detectPreferredToolChoice(messages, tools) {
  const text = collectUserText(messages);
  if (!text) return null;
  const userTokens = tokenize(text).filter(t => !isLowSignalToken(t));
  if (userTokens.length === 0) return null;
  const isDocsSearchIntent =
    /\b(search|docs?|documentation|library|reference|manual|guide)\b/.test(text);

  let best = null;
  for (const tool of tools || []) {
    const name = tool?.function?.name || tool?.name || "";
    if (!name || typeof name !== "string" || !name.startsWith("mcp__")) continue;
    const desc = tool?.function?.description || tool?.description || "";
    const haystack = `${normalizeToolName(name)} ${desc}`.toLowerCase();
    let score = userTokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
    if (isDocsSearchIntent) {
      if (/\b(query|search|docs?|documentation)\b/.test(haystack)) score += 2;
      if (/\bresolve|list|id\b/.test(haystack)) score -= 1;
    }
    if (score <= 0) continue;
    if (!best || score > best.score) best = { name, score };
  }

  if (!best || best.score < 1) return null;
  return { type: "function", function: { name: best.name } };
}

function prioritizeToolsByChoice(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length < 2) return tools;
  const preferredName = typeof toolChoice === "object"
    ? (toolChoice?.function?.name || toolChoice?.name || "")
    : "";
  if (!preferredName) return tools;
  const idx = tools.findIndex((tool) => {
    const name = tool?.function?.name || tool?.name || "";
    return name === preferredName;
  });
  if (idx <= 0) return tools;
  const reordered = tools.slice();
  const [picked] = reordered.splice(idx, 1);
  reordered.unshift(picked);
  return reordered;
}

function convertMessages(messages) {
  const result = [];
  
  // Build a map of tool_call_id -> tool name from assistant tool calls
  const toolCallMetaMap = new Map();
  const rememberToolMeta = (toolCallId, toolName) => {
    if (!toolCallId) return;
    const name = toolName || "tool";
    toolCallMetaMap.set(toolCallId, { name });
    const normalized = normalizeToolCallId(toolCallId);
    if (normalized && normalized !== toolCallId) {
      toolCallMetaMap.set(normalized, { name });
    }
  };

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        rememberToolMeta(tc.id || "", tc.function?.name || "tool");
      }
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type !== "tool_use") continue;
        rememberToolMeta(part.id || "", part.name || "tool");
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      result.push({
        role: "user",
        content: `[System Instructions]\n${extractContent(msg.content)}`
      });
      continue;
    }

    if (msg.role === "tool") {
      const toolContent = extractContent(msg.content);
      const toolCallId = msg.tool_call_id || "";
      const toolMeta = toolCallMetaMap.get(toolCallId) || {};
      const toolName = msg.name || toolMeta.name || "tool";
      result.push({
        role: "user",
        content: buildToolResultBlock(toolName, toolCallId, toolContent)
      });
      continue;
    }

    if (msg.role === "user" || msg.role === "assistant") {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const parts = [];
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text") {
            if (typeof block.text === "string") {
              parts.push(block.text || "");
            }
            continue;
          }
          if (block.type === "tool_result") {
            const toolCallId = block.tool_use_id || "";
            const toolMeta =
              toolCallMetaMap.get(toolCallId) ||
              toolCallMetaMap.get(normalizeToolCallId(toolCallId));
            const toolName = toolMeta?.name || "tool";
            const toolContent = extractContent(block.content);
            parts.push(buildToolResultBlock(toolName, toolCallId, toolContent));
          }
        }
        const joined = parts.filter(Boolean).join("\n");
        if (joined) result.push({ role: "user", content: joined });
        continue;
      }

      const content = extractContent(msg.content);

      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const assistantMsg = { role: "assistant", content: content || "" };
        assistantMsg.tool_calls = msg.tool_calls.map(tc => {
          const { index, ...rest } = tc || {};
          return rest;
        });
        result.push(assistantMsg);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const extractedToolCalls = msg.content
          .filter(b => b?.type === "tool_use")
          .map(b => ({
            id: b.id || "",
            type: "function",
            function: {
              name: b.name || "tool",
              arguments: JSON.stringify(b.input || {})
            }
          }))
          .filter(tc => tc.id);

        if (extractedToolCalls.length > 0) {
          result.push({
            role: "assistant",
            content: content || "",
            tool_calls: extractedToolCalls
          });
        } else if (content) {
          result.push({ role: "assistant", content });
        }
      } else {
        if (content) {
          result.push({ role: msg.role, content });
        }
      }
    }
  }

  return result;
}

export function buildCursorRequest(model, body, stream, credentials) {
  const messages = convertMessages(body.messages || []);

  // Strip fields irrelevant to Cursor (OpenAI/Anthropic-specific)
  const { user, metadata, stream_options, system, ...rest } = body;
  const inferredToolChoice = detectPreferredToolChoice(body.messages || [], body.tools || []);
  const finalToolChoice = body.tool_choice || inferredToolChoice;
  const prioritizedTools = prioritizeToolsByChoice(body.tools || [], finalToolChoice);

  return {
    ...rest,
    messages,
    ...(Array.isArray(body.tools) ? { tools: prioritizedTools } : {}),
    ...(finalToolChoice ? { tool_choice: finalToolChoice } : {}),
    max_tokens: 32000
  };
}

register(FORMATS.OPENAI, FORMATS.CURSOR, buildCursorRequest, null);
