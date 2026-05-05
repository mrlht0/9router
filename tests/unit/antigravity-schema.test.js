import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/helpers/geminiHelper.js";

describe("Antigravity schema normalization", () => {
  it("removes $id and unevaluatedProperties recursively", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      $id: "https://example.test/schema.json",
      unevaluatedProperties: false,
      properties: {
        nested: {
          type: "object",
          $id: "nested-id",
          unevaluatedProperties: false,
          properties: { value: { type: "string" } }
        }
      }
    });

    expect(cleaned).not.toHaveProperty("$id");
    expect(cleaned).not.toHaveProperty("unevaluatedProperties");
    expect(cleaned.properties.nested).not.toHaveProperty("$id");
    expect(cleaned.properties.nested).not.toHaveProperty("unevaluatedProperties");
  });

  it("adds default string items to arrays missing items", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        tags: { type: "array", description: "Labels" },
        nested: {
          type: "object",
          properties: {
            values: { type: "array" }
          }
        }
      }
    });

    expect(cleaned.properties.tags.items).toEqual({ type: "string" });
    expect(cleaned.properties.nested.properties.values.items).toEqual({ type: "string" });
  });

  it("preserves $ref, const/enum unions, and constraints as supported hints", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/LinkedThing" },
        mode: {
          oneOf: [{ const: "fast" }, { const: "safe" }, { type: "null" }]
        },
        code: {
          type: ["string", "number", "null"],
          minLength: 3,
          pattern: "^[A-Z]+$",
          description: "Short code"
        }
      }
    });

    expect(cleaned.properties.linked).not.toHaveProperty("$ref");
    expect(cleaned.properties.linked.type).toBe("object");
    expect(cleaned.properties.linked.description).toContain("See: LinkedThing");
    expect(cleaned.properties.linked.properties.reason.type).toBe("string");

    expect(cleaned.properties.mode).not.toHaveProperty("oneOf");
    expect(cleaned.properties.mode).toMatchObject({ type: "string", enum: ["fast", "safe"] });
    expect(cleaned.properties.mode.description).toContain("Allowed: fast, safe");

    expect(cleaned.properties.code).not.toHaveProperty("minLength");
    expect(cleaned.properties.code).not.toHaveProperty("pattern");
    expect(cleaned.properties.code.type).toBe("string");
    expect(cleaned.properties.code.description).toContain("minLength: 3");
    expect(cleaned.properties.code.description).toContain("pattern: ^[A-Z]+$");
    expect(cleaned.properties.code.description).toContain("Accepts: string | number");
    expect(cleaned.properties.code.description).toContain("nullable");
  });
});
