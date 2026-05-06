/**
 * Cursor Code-Edit Block Translator
 *
 * Cursor's hosted Claude/GPT models are server-trained to emit file modifications as
 *
 *     ```N:M:path/to/file
 *     <new content>
 *     ```
 *
 * markdown blocks (the IDE's "fast-apply" format). When 9Router proxies these
 * responses to Claude Code (or any other client that expects native tool_use), the
 * blocks render as plain text and never get applied — the user sees a diff but no
 * actual file change.
 *
 * This translator parses code-edit blocks out of an accumulated assistant text
 * response and rewrites them as Edit / Write tool_use calls. It cooperates with
 * the conversation history (already-translated Cursor message format) to recover
 * the original `old_string` from the most recent Read tool result on the same
 * file, so the synthesised Edit is exact.
 *
 * Public surface:
 *   parseCodeEditBlocks(text) -> [{ startLine, endLine, filePath, newContent, raw, span }]
 *   resolveEditFromHistory(messages, edit) -> { tool, args }
 *   stripCodeEditBlocks(text, edits) -> string with blocks removed
 */

const CODE_EDIT_RE = /```(\d+):(\d+):([^\n`]+)\n([\s\S]*?)\n```/g;

export function parseCodeEditBlocks(text) {
  if (typeof text !== "string" || !text.includes("```")) return [];
  CODE_EDIT_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = CODE_EDIT_RE.exec(text)) !== null) {
    out.push({
      startLine: parseInt(m[1], 10),
      endLine: parseInt(m[2], 10),
      filePath: m[3].trim(),
      newContent: m[4],
      raw: m[0],
      span: { start: m.index, end: m.index + m[0].length }
    });
  }
  return out;
}

export function stripCodeEditBlocks(text, edits) {
  if (!edits || edits.length === 0) return text;
  // Remove blocks from end-to-start so spans stay valid
  const sorted = [...edits].sort((a, b) => b.span.start - a.span.start);
  let result = text;
  for (const e of sorted) {
    result = result.slice(0, e.span.start) + result.slice(e.span.end);
  }
  // Collapse runs of blank lines left behind
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Parse `cat -n` output into an array indexed by line number (1-based -> array[0]).
// Tolerates rows that don't match the expected pattern (preserves them as-is).
export function parseCatNContent(catText) {
  const lines = [];
  for (const raw of String(catText || "").split("\n")) {
    const m = raw.match(/^\s*(\d+)\t(.*)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      lines[idx] = m[2];
    }
  }
  // Fill any holes
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === undefined) lines[i] = "";
  }
  return lines;
}

// Extract the most recent Read tool result for a given file path from the
// (already cursor-format) message history. Returns the cat -n string, or null.
export function findLatestReadResult(messages, filePath) {
  if (!Array.isArray(messages) || !filePath) return null;

  // First, build a map of toolCallId -> file_path from assistant tool_calls
  const callIdToPath = new Map();
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tc of calls) {
      const name = tc?.function?.name || tc?.name;
      if (name !== "Read") continue;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
      const fp = args?.file_path || args?.path || args?.target_file;
      if (fp && tc?.id) callIdToPath.set(tc.id, fp);
    }
  }

  // Walk messages backward; find user-role <tool_result> with matching path.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user" || typeof msg.content !== "string") continue;
    const blocks = [...msg.content.matchAll(/<tool_result>([\s\S]*?)<\/tool_result>/g)];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const inner = blocks[b][1];
      const idMatch = inner.match(/<tool_call_id>([^<]*)<\/tool_call_id>/);
      const nameMatch = inner.match(/<tool_name>([^<]+)<\/tool_name>/);
      const resultMatch = inner.match(/<result>([\s\S]*?)<\/result>/);
      if (!nameMatch || !resultMatch) continue;
      if (decodeXmlEntities(nameMatch[1].trim()) !== "Read") continue;
      const callId = idMatch ? decodeXmlEntities(idMatch[1].trim()) : "";
      const knownPath = callIdToPath.get(callId);
      if (!knownPath) continue;
      // Match on suffix to tolerate absolute vs relative paths the model emits
      if (knownPath === filePath || knownPath.endsWith(filePath) || filePath.endsWith(knownPath)) {
        return decodeXmlEntities(resultMatch[1]);
      }
    }
  }
  return null;
}

// Build a tool call that semantically applies the given code-edit block.
// Prefers Edit (exact old_string/new_string) when we can recover the original
// lines from a prior Read; otherwise falls back to Write (full overwrite).
export function resolveEditFromHistory(messages, edit) {
  const catText = findLatestReadResult(messages, edit.filePath);
  if (catText) {
    const lines = parseCatNContent(catText);
    const startIdx = Math.max(0, edit.startLine - 1);
    const endIdx = Math.max(startIdx, edit.endLine - 1);
    if (startIdx < lines.length) {
      const oldSlice = lines.slice(startIdx, endIdx + 1).join("\n");
      return {
        tool: "Edit",
        args: {
          file_path: edit.filePath,
          old_string: oldSlice,
          new_string: edit.newContent
        }
      };
    }
  }
  // Fallback: Write the new content as the entire file. Lossy if the file had
  // content outside the edited range, but better than emitting nothing.
  return {
    tool: "Write",
    args: {
      file_path: edit.filePath,
      content: edit.newContent
    }
  };
}
