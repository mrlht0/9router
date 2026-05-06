import { describe, it, expect } from "vitest";
import {
  parseCodeEditBlocks,
  stripCodeEditBlocks,
  parseCatNContent,
  findLatestReadResult,
  resolveEditFromHistory
} from "../../open-sse/utils/cursorCodeEditTranslator.js";

describe("cursor code-edit translator", () => {
  it("parses a single code-edit block", () => {
    const text =
      "Baik, saya update.\n\n```1:1:test.md\n# wkwkwk\n```\n\nDone.";
    const blocks = parseCodeEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      startLine: 1,
      endLine: 1,
      filePath: "test.md",
      newContent: "# wkwkwk"
    });
  });

  it("parses multiple code-edit blocks", () => {
    const text =
      "First:\n```1:2:a.md\nfoo\nbar\n```\nSecond:\n```5:5:b.md\nbaz\n```\n";
    const blocks = parseCodeEditBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].filePath).toBe("a.md");
    expect(blocks[1].filePath).toBe("b.md");
  });

  it("returns no blocks for plain text", () => {
    expect(parseCodeEditBlocks("Hello, no code blocks here.")).toEqual([]);
    expect(parseCodeEditBlocks("Just a ```js fence``` not a code-edit")).toEqual([]);
  });

  it("strips code-edit blocks while preserving surrounding prose", () => {
    const text =
      "Saya update file:\n\n```1:1:test.md\n# new title\n```\n\nDone.";
    const blocks = parseCodeEditBlocks(text);
    const stripped = stripCodeEditBlocks(text, blocks);
    expect(stripped).toContain("Saya update file");
    expect(stripped).toContain("Done.");
    expect(stripped).not.toContain("# new title");
    expect(stripped).not.toContain("```");
  });

  it("parses cat -n format with line numbers", () => {
    const text = "    1\tline-one\n    2\tline-two\n    3\tline-three\n";
    expect(parseCatNContent(text)).toEqual(["line-one", "line-two", "line-three"]);
  });

  it("finds latest Read result for matching file path", () => {
    const messages = [
      { role: "user", content: "[System Instructions]\nfoo" },
      { role: "user", content: "please read test.md" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "toolu_abc123",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: "/repo/test.md" }) }
          }
        ]
      },
      {
        role: "user",
        content:
          "<tool_result>\n<tool_name>Read</tool_name>\n<tool_call_id>toolu_abc123</tool_call_id>\n<result>     1\t# old title\n</result>\n</tool_result>"
      }
    ];
    const found = findLatestReadResult(messages, "/repo/test.md");
    expect(found).toBeTruthy();
    expect(found).toContain("# old title");
  });

  it("matches Read by relative path suffix", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "toolu_x",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: "/abs/repo/test.md" }) }
          }
        ]
      },
      {
        role: "user",
        content:
          "<tool_result>\n<tool_name>Read</tool_name>\n<tool_call_id>toolu_x</tool_call_id>\n<result>1\tcontent\n</result>\n</tool_result>"
      }
    ];
    expect(findLatestReadResult(messages, "test.md")).toContain("content");
  });

  it("resolves an Edit tool call when prior Read is in history", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "toolu_id",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: "test.md" }) }
          }
        ]
      },
      {
        role: "user",
        content:
          "<tool_result>\n<tool_name>Read</tool_name>\n<tool_call_id>toolu_id</tool_call_id>\n<result>     1\t# popopopopopo\n     2\t\n</result>\n</tool_result>"
      }
    ];
    const edit = { startLine: 1, endLine: 1, filePath: "test.md", newContent: "# wkwkwk" };
    const resolved = resolveEditFromHistory(messages, edit);
    expect(resolved.tool).toBe("Edit");
    expect(resolved.args).toEqual({
      file_path: "test.md",
      old_string: "# popopopopopo",
      new_string: "# wkwkwk"
    });
  });

  it("falls back to Write when no prior Read is available", () => {
    const messages = [{ role: "user", content: "do the thing" }];
    const edit = { startLine: 1, endLine: 1, filePath: "fresh.md", newContent: "# new file" };
    const resolved = resolveEditFromHistory(messages, edit);
    expect(resolved.tool).toBe("Write");
    expect(resolved.args).toEqual({ file_path: "fresh.md", content: "# new file" });
  });
});
