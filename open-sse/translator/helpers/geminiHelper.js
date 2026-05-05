// Gemini helper functions for translator

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "minItems", "maxItems", "format",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$id", "$defs", "definitions", "const", "$ref", "$comment",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  "unevaluatedProperties", "unevaluatedItems",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "if", "then", "else", "contains", "minContains", "maxContains",
  "prefixItems", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor"
];

const DESCRIPTION_HINT_CONSTRAINTS = [
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "minItems", "maxItems", "format", "default", "examples"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text") {
        parts.push({ text: item.text });
      } else if (item.type === "image_url" && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === "image_url" && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === "text").map(c => c.text).join("");
  }
  return "";
}

// Try parse JSON safely
export function tryParseJSON(str) {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

function appendDescriptionHint(obj, hint) {
  if (!obj || typeof obj !== "object" || !hint) return;

  const description = typeof obj.description === "string" ? obj.description : "";
  if (description.includes(hint)) return;
  obj.description = description ? `${description} (${hint})` : hint;
}

function schemaTypeLabel(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.type)) return schema.type.filter(t => t !== "null").join(" | ") || "null";
  if (typeof schema.type === "string") return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (schema.const !== undefined || schema.enum) return "string";
  return "unknown";
}

function formatHintValue(value) {
  if (Array.isArray(value)) {
    return value.map(formatHintValue).join(", ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function refName(ref) {
  const tail = ref.includes("/") ? ref.split("/").pop() : ref;
  return tail ? decodeURIComponent(tail.replace(/~1/g, "/").replace(/~0/g, "~")) : ref;
}

// Helper: Remove unsupported keywords recursively from object/array.
// The `properties` object maps user-facing property names to schemas, so those
// keys must be preserved even when a property name matches an unsupported keyword.
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini.
function removeUnsupportedKeywords(obj, keywords, insideProperties = false) {
  if (!obj || typeof obj !== "object") return;

  if (insideProperties) {
    for (const propSchema of Object.values(obj)) {
      if (propSchema && typeof propSchema === "object") {
        removeUnsupportedKeywords(propSchema, keywords, false);
      }
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      removeUnsupportedKeywords(item, keywords, false);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    if (key === "properties") {
      const value = obj[key];
      if (value && typeof value === "object") {
        removeUnsupportedKeywords(value, keywords, true);
      }
      continue;
    }

    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
      continue;
    }

    const value = obj[key];
    if (value && typeof value === "object") {
      removeUnsupportedKeywords(value, keywords, false);
    }
  }
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      convertConstToEnum(item);
    }
    return;
  }

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertConstToEnum(value);
    }
  }
}

// Convert $ref and unsupported validation constraints to natural-language hints
// before later phases remove the strict JSON Schema keywords Antigravity rejects.
function moveUnsupportedSemanticsToDescription(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      moveUnsupportedSemanticsToDescription(item);
    }
    return;
  }

  if (typeof obj.$ref === "string") {
    appendDescriptionHint(obj, `See: ${refName(obj.$ref)}`);
    if (!obj.type) obj.type = "object";
  }

  if (obj.additionalProperties === false) {
    appendDescriptionHint(obj, "No extra properties allowed");
  }

  for (const constraint of DESCRIPTION_HINT_CONSTRAINTS) {
    if (obj[constraint] !== undefined) {
      appendDescriptionHint(obj, `${constraint}: ${formatHintValue(obj[constraint])}`);
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      moveUnsupportedSemanticsToDescription(value);
    }
  }
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      convertEnumValuesToStrings(item);
    }
    return;
  }

  if (obj.enum && Array.isArray(obj.enum)) {
    obj.enum = obj.enum.map(v => String(v));
    // Gemini API requires type:"string" when enum is present — without it returns 400
    if (!obj.type) {
      obj.type = "string";
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertEnumValuesToStrings(value);
    }
  }
}

function addEnumHints(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      addEnumHints(item);
    }
    return;
  }

  if (Array.isArray(obj.enum) && obj.enum.length > 1 && obj.enum.length <= 10) {
    appendDescriptionHint(obj, `Allowed: ${obj.enum.map(v => String(v)).join(", ")}`);
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      addEnumHints(value);
    }
  }
}

// Merge allOf schemas
function mergeAllOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      mergeAllOf(item);
    }
    return;
  }

  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged = {};

    for (const item of obj.allOf) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (item.properties) {
        if (!merged.properties) merged.properties = {};
        Object.assign(merged.properties, item.properties);
      }
      if (item.required && Array.isArray(item.required)) {
        if (!merged.required) merged.required = [];
        for (const req of item.required) {
          if (!merged.required.includes(req)) {
            merged.required.push(req);
          }
        }
      }

      for (const [key, value] of Object.entries(item)) {
        if (key !== "properties" && key !== "required" && merged[key] === undefined) {
          merged[key] = value;
        }
      }
    }

    delete obj.allOf;
    if (merged.properties) obj.properties = { ...obj.properties, ...merged.properties };
    if (merged.required) obj.required = Array.from(new Set([...(obj.required || []), ...merged.required]));
    for (const [key, value] of Object.entries(merged)) {
      if (key !== "properties" && key !== "required" && obj[key] === undefined) {
        obj[key] = value;
      }
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      mergeAllOf(value);
    }
  }
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function tryMergeEnumFromUnion(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const values = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (item.type === "null") continue;

    if (item.const !== undefined) {
      values.push(item.const);
      continue;
    }

    if (Array.isArray(item.enum) && item.enum.length > 0) {
      values.push(...item.enum);
      continue;
    }

    return null;
  }

  return values.length > 0 ? Array.from(new Set(values.map(v => String(v)))) : null;
}

function collectUnionTypeHint(items) {
  const types = [];
  for (const item of items) {
    const label = schemaTypeLabel(item);
    if (label && label !== "unknown") {
      types.push(label);
    }
  }

  return Array.from(new Set(types));
}

// Flatten anyOf/oneOf
function flattenAnyOfOneOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      flattenAnyOfOneOf(item);
    }
    return;
  }

  if (obj.anyOf && Array.isArray(obj.anyOf) && obj.anyOf.length > 0) {
    const unionTypes = collectUnionTypeHint(obj.anyOf);
    const mergedEnum = tryMergeEnumFromUnion(obj.anyOf);
    if (mergedEnum) {
      delete obj.anyOf;
      obj.type = "string";
      obj.enum = mergedEnum;
      if (unionTypes.length > 1) appendDescriptionHint(obj, `Accepts: ${unionTypes.join(" | ")}`);
    }
    const nonNullSchemas = obj.anyOf?.filter(s => s && s.type !== "null") || [];
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.anyOf;
      const description = obj.description;
      flattenAnyOfOneOf(selected);
      Object.assign(obj, selected);
      if (description) obj.description = selected.description && selected.description !== description
        ? `${description} (${selected.description})`
        : description;
      if (unionTypes.length > 1) appendDescriptionHint(obj, `Accepts: ${unionTypes.join(" | ")}`);
    }
  }

  if (obj.oneOf && Array.isArray(obj.oneOf) && obj.oneOf.length > 0) {
    const unionTypes = collectUnionTypeHint(obj.oneOf);
    const mergedEnum = tryMergeEnumFromUnion(obj.oneOf);
    if (mergedEnum) {
      delete obj.oneOf;
      obj.type = "string";
      obj.enum = mergedEnum;
      if (unionTypes.length > 1) appendDescriptionHint(obj, `Accepts: ${unionTypes.join(" | ")}`);
    }
    const nonNullSchemas = obj.oneOf?.filter(s => s && s.type !== "null") || [];
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.oneOf;
      const description = obj.description;
      flattenAnyOfOneOf(selected);
      Object.assign(obj, selected);
      if (description) obj.description = selected.description && selected.description !== description
        ? `${description} (${selected.description})`
        : description;
      if (unionTypes.length > 1) appendDescriptionHint(obj, `Accepts: ${unionTypes.join(" | ")}`);
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenAnyOfOneOf(value);
    }
  }
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      flattenTypeArrays(item);
    }
    return;
  }

  if (obj.type && Array.isArray(obj.type)) {
    const hasNull = obj.type.includes("null");
    const nonNullTypes = obj.type.filter(t => t !== "null");
    obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
    if (nonNullTypes.length > 1) {
      appendDescriptionHint(obj, `Accepts: ${nonNullTypes.join(" | ")}`);
    }
    if (hasNull) {
      appendDescriptionHint(obj, "nullable");
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenTypeArrays(value);
    }
  }
}

function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      ensureArrayItems(item);
    }
    return;
  }

  if (obj.type === "array" && !obj.items) {
    obj.items = { type: "string" };
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      ensureArrayItems(value);
    }
  }
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  moveUnsupportedSemanticsToDescription(cleaned);
  convertEnumValuesToStrings(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);
  ensureArrayItems(cleaned);
  convertEnumValuesToStrings(cleaned);
  addEnumHints(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  function cleanupRequired(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.required && Array.isArray(obj.required) && obj.properties) {
      const validRequired = obj.required.filter(field =>
        Object.prototype.hasOwnProperty.call(obj.properties, field)
      );
      if (validRequired.length === 0) {
        delete obj.required;
      } else {
        obj.required = validRequired;
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        cleanupRequired(value);
      }
    }
  }

  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  function addPlaceholders(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.type === "object") {
      if (!obj.properties || Object.keys(obj.properties).length === 0) {
        obj.properties = {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool"
          }
        };
        obj.required = ["reason"];
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        addPlaceholders(value);
      }
    }
  }

  addPlaceholders(cleaned);

  return cleaned;
}
