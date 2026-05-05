import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Antigravity thinking signature translation", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_777_777_777_000);
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves thoughtSignature in providerMetadata and restores it when converting back", async () => {
    const { antigravityToOpenAIRequest } = await import("../../open-sse/translator/request/antigravity-to-openai.js");
    const { openaiToAntigravityRequest } = await import("../../open-sse/translator/request/openai-to-gemini.js");
    const signature = "ag-thinking-signature-887";

    const openai = antigravityToOpenAIRequest("gemini-3-pro", {
      request: {
        contents: [{
          role: "model",
          parts: [
            { thought: true, text: "private reasoning", thoughtSignature: signature },
            { text: "I will call the tool now.", thoughtSignature: signature },
            {
              thoughtSignature: signature,
              functionCall: {
                id: "call_887",
                name: "lookup_issue",
                args: { issue: 887 }
              }
            }
          ]
        }]
      }
    }, true);

    const assistant = openai.messages.find((message) => message.role === "assistant");
    expect(assistant.providerMetadata.antigravity.thoughtSignature).toBe(signature);
    expect(assistant.providerMetadata.antigravity.signature).toBe(signature);
    expect(assistant.tool_calls[0].providerMetadata.antigravity.thoughtSignature).toBe(signature);

    const antigravity = openaiToAntigravityRequest("gemini-3-pro", openai, true, {
      email: "ag@example.test",
      projectId: "test-project"
    });
    const modelParts = antigravity.request.contents.find((content) => content.role === "model").parts;

    expect(modelParts.find((part) => part.thought === true).thoughtSignature).toBe(signature);
    expect(modelParts.find((part) => part.functionCall?.id === "call_887").thoughtSignature).toBe(signature);
  });
});
