import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

import { isApiKeyAllowedForProvider } from "../../src/sse/services/auth.js";
import {
  createApiKey,
  updateApiKey,
  getApiKeys,
  createProviderPool,
  updateProviderPool,
  deleteProviderPool,
  getProviderPoolById,
  getApiKeyRecord,
} from "../../src/lib/localDb.js";

import { POST as createProviderPoolRoute, GET as listProviderPoolsRoute } from "../../src/app/api/provider-pools/route.js";
import {
  PUT as updateProviderPoolRoute,
  DELETE as deleteProviderPoolRoute,
} from "../../src/app/api/provider-pools/[id]/route.js";

describe("api key provider scope", () => {
  it("allows all providers when allowedProviders is empty", async () => {
    const key = await createApiKey(`test-all-${Date.now()}`, "machine-test");
    const allowed = await isApiKeyAllowedForProvider(key.key, "openai");

    expect(allowed).toBe(true);
  });

  it("only allows listed providers when restricted", async () => {
    const key = await createApiKey(`test-scope-${Date.now()}`, "machine-test", ["openai", "anthropic"]);

    const allowOpenai = await isApiKeyAllowedForProvider(key.key, "openai");
    const allowAnthropic = await isApiKeyAllowedForProvider(key.key, "anthropic");
    const allowGemini = await isApiKeyAllowedForProvider(key.key, "gemini");

    expect(allowOpenai).toBe(true);
    expect(allowAnthropic).toBe(true);
    expect(allowGemini).toBe(false);
  });

  it("uses provider pool when selected", async () => {
    const pool = await createProviderPool({
      name: `pool-${Date.now()}`,
      providerIds: ["openai"],
    });

    const key = await createApiKey(`test-pool-${Date.now()}`, "machine-test", ["anthropic"], pool.id);

    const allowOpenai = await isApiKeyAllowedForProvider(key.key, "openai");
    const allowAnthropic = await isApiKeyAllowedForProvider(key.key, "anthropic");

    expect(allowOpenai).toBe(true);
    expect(allowAnthropic).toBe(false);

    await deleteProviderPool(pool.id);
  });

  it("falls back to legacy allowedProviders when no pool", async () => {
    const key = await createApiKey(`test-legacy-${Date.now()}`, "machine-test", ["anthropic"]);
    const allowOpenai = await isApiKeyAllowedForProvider(key.key, "openai");
    const allowAnthropic = await isApiKeyAllowedForProvider(key.key, "anthropic");

    expect(allowOpenai).toBe(false);
    expect(allowAnthropic).toBe(true);
  });

  it("denies inactive keys", async () => {
    const key = await createApiKey(`test-inactive-${Date.now()}`, "machine-test", ["openai"]);
    await updateApiKey(key.id, { isActive: false });

    const allowed = await isApiKeyAllowedForProvider(key.key, "openai");

    expect(allowed).toBe(false);
  });

  it("denies when selected provider pool is missing", async () => {
    const key = await createApiKey(`test-missing-pool-${Date.now()}`, "machine-test", [], "missing-pool-id");

    const allowed = await isApiKeyAllowedForProvider(key.key, "openai");

    expect(allowed).toBe(false);
  });

  it("deleting a provider pool unsets providerPoolId on referencing api keys", async () => {
    const pool = await createProviderPool({
      name: `pool-delete-${Date.now()}`,
      providerIds: ["openai"],
    });
    const key = await createApiKey(`test-delete-pool-${Date.now()}`, "machine-test", [], pool.id);

    await deleteProviderPool(pool.id);

    const reloaded = await getApiKeyRecord(key.key);
    expect(reloaded.providerPoolId).toBeNull();
    expect(await isApiKeyAllowedForProvider(key.key, "gemini")).toBe(true);
  });

  it("creates, lists, updates, and deletes provider pools through API routes", async () => {
    const createResponse = await createProviderPoolRoute({
      json: async () => ({ name: "  Test Pool Route  ", providerIds: ["openai"] }),
    });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.pool.name).toBe("Test Pool Route");
    expect(createResponse.body.pool.providerIds).toEqual(["openai"]);

    const poolId = createResponse.body.pool.id;
    const listResponse = await listProviderPoolsRoute();
    expect(listResponse.body.pools.some((pool) => pool.id === poolId)).toBe(true);

    const updateResponse = await updateProviderPoolRoute(
      { json: async () => ({ name: "Updated Pool", providerIds: ["anthropic", "gemini"] }) },
      { params: Promise.resolve({ id: poolId }) },
    );
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.pool.name).toBe("Updated Pool");
    expect(updateResponse.body.pool.providerIds).toEqual(["anthropic", "gemini"]);

    const deleteResponse = await deleteProviderPoolRoute({}, { params: Promise.resolve({ id: poolId }) });
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);
    expect(await getProviderPoolById(poolId)).toBeNull();
  });

  it("validates provider pool route input", async () => {
    const missingName = await createProviderPoolRoute({ json: async () => ({ name: "", providerIds: [] }) });
    expect(missingName.status).toBe(400);

    const invalidProviders = await createProviderPoolRoute({ json: async () => ({ name: "Bad", providerIds: "openai" }) });
    expect(invalidProviders.status).toBe(400);

    const missingPool = await updateProviderPoolRoute(
      { json: async () => ({ name: "Missing" }) },
      { params: Promise.resolve({ id: "missing-provider-pool" }) },
    );
    expect(missingPool.status).toBe(404);
  });

  it("exposes allowedProviders as an array for existing keys", async () => {
    const keys = await getApiKeys();

    for (const key of keys) {
      expect(Array.isArray(key.allowedProviders)).toBe(true);
    }
  });
});
