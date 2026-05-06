import { describe, it, expect } from "vitest";
import { buildCursorRequest } from "../../open-sse/translator/request/openai-to-cursor.js";

describe("openai-to-cursor tool choice bias", () => {
  it("keeps explicit tool_choice when provided", () => {
    const req = buildCursorRequest("default", {
      messages: [{ role: "user", content: "use context7" }],
      tools: [{ type: "function", function: { name: "mcp__context7__query-docs" } }],
      tool_choice: { type: "function", function: { name: "mcp__context7__resolve-library-id" } },
    }, true, null);

    expect(req.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__context7__resolve-library-id" },
    });
  });

  it("infers context7 tool_choice from user intent", () => {
    const req = buildCursorRequest("default", {
      messages: [{ role: "user", content: "please use context7 to search svelte docs" }],
      tools: [{ type: "function", function: { name: "mcp__context7__query-docs" } }],
    }, true, null);

    expect(req.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__context7__query-docs" },
    });
  });

  it("infers svelte tool_choice when svelte MCP is available", () => {
    const req = buildCursorRequest("default", {
      messages: [{ role: "user", content: "please use svelte tool" }],
      tools: [{ type: "function", function: { name: "mcp__svelte__get-documentation" } }],
    }, true, null);

    expect(req.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__svelte__get-documentation" },
    });
  });

  it("dynamically matches non-hardcoded MCP server/tool names", () => {
    const req = buildCursorRequest("default", {
      messages: [{ role: "user", content: "please create github issue for crash bug" }],
      tools: [
        { type: "function", function: { name: "mcp__github__create_issue", description: "Create a GitHub issue" } },
        { type: "function", function: { name: "mcp__context7__query-docs", description: "Search docs" } },
      ],
    }, true, null);

    expect(req.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__github__create_issue" },
    });
  });

  it("moves preferred tool to front of tools list", () => {
    const req = buildCursorRequest("default", {
      messages: [{ role: "user", content: "please create github issue for crash bug" }],
      tools: [
        { type: "function", function: { name: "mcp__context7__query-docs", description: "Search docs" } },
        { type: "function", function: { name: "mcp__github__create_issue", description: "Create a GitHub issue" } },
      ],
    }, true, null);

    expect(req.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__github__create_issue" },
    });
    expect(req.tools[0].function.name).toBe("mcp__github__create_issue");
  });

  it("prefers query-docs over resolve-library-id for docs search intent", () => {
    const req = buildCursorRequest("default", {
      messages: [{ role: "user", content: "please use context7 tools for search library svelte docs" }],
      tools: [
        { type: "function", function: { name: "mcp__plugin_context7_context7__resolve-library-id", description: "Resolve a library id by name" } },
        { type: "function", function: { name: "mcp__plugin_context7_context7__query-docs", description: "Query documentation pages" } },
      ],
    }, true, null);

    expect(req.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__plugin_context7_context7__query-docs" },
    });
    expect(req.tools[0].function.name).toBe("mcp__plugin_context7_context7__query-docs");
  });
});
