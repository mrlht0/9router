import { describe, it, expect } from "vitest";
import {
  parseCodeEditBlocks,
  stripCodeEditBlocks,
  parseCatNContent,
  findLatestReadResult,
  resolveEditFromHistory,
  extractDeepSeekResponse,
  parseDeepSeekToolCalls
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

describe("DeepSeek-embedded tool calls", () => {
  it("extracts a single StrReplace and maps to Edit", () => {
    const thinking = [
      "Some chain-of-thought reasoning here.",
      "</think>",
      "Memperbarui judul di `test.md` menjadi `# HUHUHU`.",
      "",
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>",
      "StrReplace",
      "<｜tool▁sep｜>path",
      "/repo/test.md",
      "<｜tool▁sep｜>old_string",
      "# wkwkwk",
      "<｜tool▁sep｜>new_string",
      "# HUHUHU",
      "<｜tool▁call▁end｜><｜tool▁calls▁end｜>"
    ].join("\n");
    const { cotText, assistantText, toolCalls } = extractDeepSeekResponse(thinking);
    expect(cotText).toContain("chain-of-thought reasoning");
    expect(assistantText).toContain("Memperbarui judul");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool).toBe("Edit");
    expect(toolCalls[0].args).toEqual({
      file_path: "/repo/test.md",
      old_string: "# wkwkwk",
      new_string: "# HUHUHU"
    });
  });

  it("maps DeepSeek View/Read variants to Read", () => {
    const thinking = [
      "</think>Reading…",
      "<｜tool▁call▁begin｜>View<｜tool▁sep｜>path",
      "/repo/x.md",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "Read",
      args: { file_path: "/repo/x.md" }
    });
  });

  it("maps Bash/RunCommand to Bash", () => {
    const thinking = [
      "</think>Running…",
      "<｜tool▁call▁begin｜>RunCommand<｜tool▁sep｜>command",
      "ls -la",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "Bash",
      args: { command: "ls -la" }
    });
  });

  it("returns empty for plain reasoning without tool tokens", () => {
    const result = extractDeepSeekResponse("just thinking, no tools here");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("maps DeepSeek Glob with target_directory/glob_pattern to Claude Code Glob", () => {
    const thinking = [
      "</think>Searching…",
      "<｜tool▁call▁begin｜>Glob<｜tool▁sep｜>target_directory",
      "/repo",
      "<｜tool▁sep｜>glob_pattern",
      "**/test.md",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "Glob",
      args: { pattern: "**/test.md", path: "/repo" }
    });
  });

  it("maps ListDir to LS", () => {
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>ListDir<｜tool▁sep｜>target_directory",
      "/repo/src",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({ tool: "LS", args: { path: "/repo/src" } });
  });

  it("maps GrepSearch to Grep", () => {
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>GrepSearch<｜tool▁sep｜>pattern",
      "TODO",
      "<｜tool▁sep｜>path",
      "/repo",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "Grep",
      args: { pattern: "TODO", path: "/repo" }
    });
  });

  it("maps Shell / Terminal aliases to Bash", () => {
    for (const name of ["Shell", "shell", "Terminal", "run_terminal_cmd", "RunTerminalCmd"]) {
      const thinking = `</think>\n<｜tool▁call▁begin｜>${name}<｜tool▁sep｜>command\nls\n<｜tool▁call▁end｜>`;
      const { toolCalls } = extractDeepSeekResponse(thinking);
      expect(toolCalls[0]).toEqual({ tool: "Bash", args: { command: "ls" } });
    }
  });

  it("maps List_dir / Listdir / Dir aliases to LS", () => {
    for (const name of ["List_dir", "Listdir", "list_directory", "Dir", "dir"]) {
      const thinking = `</think>\n<｜tool▁call▁begin｜>${name}<｜tool▁sep｜>target_directory\n/repo\n<｜tool▁call▁end｜>`;
      const { toolCalls } = extractDeepSeekResponse(thinking);
      expect(toolCalls[0]).toEqual({ tool: "LS", args: { path: "/repo" } });
    }
  });

  it("maps Cat / OpenFile aliases to Read", () => {
    for (const name of ["Cat", "cat", "OpenFile", "open_file", "view"]) {
      const thinking = `</think>\n<｜tool▁call▁begin｜>${name}<｜tool▁sep｜>path\n/repo/x.md\n<｜tool▁call▁end｜>`;
      const { toolCalls } = extractDeepSeekResponse(thinking);
      expect(toolCalls[0]).toEqual({ tool: "Read", args: { file_path: "/repo/x.md" } });
    }
  });

  it("maps DeepSeek WebSearch with search_term to WebSearch.query", () => {
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>WebSearch<｜tool▁sep｜>search_term",
      "SvelteKit framework routing adapters documentation 2024",
      "<｜tool▁sep｜>explanation",
      "Mengambil ringkasan dokumentasi resmi SvelteKit",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "WebSearch",
      args: { query: "SvelteKit framework routing adapters documentation 2024" }
    });
  });

  it("splits </think> boundary even when no tool tokens are present", () => {
    const thinking = [
      "User asked to update test.md.",
      "I will apply the change and confirm.",
      "</think>",
      "**Sudah diperbarui.** File `test.md` sekarang berjudul **Perangkat lunak**."
    ].join("\n");
    const { cotText, assistantText, toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls).toHaveLength(0);
    expect(cotText).toContain("User asked");
    expect(assistantText).toContain("Sudah diperbarui");
    expect(assistantText).not.toContain("</think>");
  });

  it("maps MultiEdit with edits JSON array", () => {
    const editsJson = JSON.stringify([
      { old_string: "foo", new_string: "bar" },
      { old: "baz", new: "qux", replace_all: true }
    ]);
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>MultiEdit<｜tool▁sep｜>path",
      "/repo/a.md",
      "<｜tool▁sep｜>edits",
      editsJson,
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0].tool).toBe("MultiEdit");
    expect(toolCalls[0].args.file_path).toBe("/repo/a.md");
    expect(toolCalls[0].args.edits).toEqual([
      { old_string: "foo", new_string: "bar" },
      { old_string: "baz", new_string: "qux", replace_all: true }
    ]);
  });

  it("maps NotebookEdit with cell_id and cell_type", () => {
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>NotebookEdit<｜tool▁sep｜>notebook_path",
      "/repo/n.ipynb",
      "<｜tool▁sep｜>cell_id",
      "abc",
      "<｜tool▁sep｜>cell_type",
      "code",
      "<｜tool▁sep｜>new_source",
      "print('hi')",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "NotebookEdit",
      args: {
        notebook_path: "/repo/n.ipynb",
        new_source: "print('hi')",
        cell_id: "abc",
        cell_type: "code"
      }
    });
  });

  it("maps Task / SpawnAgent to Task with subagent_type", () => {
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>SpawnAgent<｜tool▁sep｜>description",
      "audit branch",
      "<｜tool▁sep｜>prompt",
      "Check if ready to ship",
      "<｜tool▁sep｜>subagent_type",
      "general-purpose",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "Task",
      args: {
        description: "audit branch",
        prompt: "Check if ready to ship",
        subagent_type: "general-purpose"
      }
    });
  });

  it("maps TodoWrite with todos JSON array", () => {
    const todosJson = JSON.stringify([
      { content: "do thing", status: "pending", activeForm: "doing thing" }
    ]);
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>TodoWrite<｜tool▁sep｜>todos",
      todosJson,
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0].tool).toBe("TodoWrite");
    expect(toolCalls[0].args.todos).toEqual([
      { content: "do thing", status: "pending", activeForm: "doing thing" }
    ]);
  });

  it("maps ExitPlanMode with plan", () => {
    const thinking = [
      "</think>",
      "<｜tool▁call▁begin｜>ExitPlanMode<｜tool▁sep｜>plan",
      "1. step one\n2. step two",
      "<｜tool▁call▁end｜>"
    ].join("\n");
    const { toolCalls } = extractDeepSeekResponse(thinking);
    expect(toolCalls[0]).toEqual({
      tool: "ExitPlanMode",
      args: { plan: "1. step one\n2. step two" }
    });
  });

  it("parses multiple tool calls in one block", () => {
    const text = [
      "<｜tool▁calls▁begin｜>",
      "<｜tool▁call▁begin｜>View<｜tool▁sep｜>path",
      "/a.md",
      "<｜tool▁call▁end｜>",
      "<｜tool▁call▁begin｜>StrReplace<｜tool▁sep｜>path",
      "/a.md",
      "<｜tool▁sep｜>old_string",
      "old",
      "<｜tool▁sep｜>new_string",
      "new",
      "<｜tool▁call▁end｜>",
      "<｜tool▁calls▁end｜>"
    ].join("\n");
    const calls = parseDeepSeekToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("View");
    expect(calls[1].name).toBe("StrReplace");
    expect(calls[1].params.old_string).toBe("old");
    expect(calls[1].params.new_string).toBe("new");
  });
});
