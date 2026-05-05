import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetProviderConnections,
  mockUpdateProviderConnection,
  mockGetSettings
} = vi.hoisted(() => ({
  mockGetProviderConnections: vi.fn(),
  mockUpdateProviderConnection: vi.fn(),
  mockGetSettings: vi.fn()
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mockGetProviderConnections,
  updateProviderConnection: mockUpdateProviderConnection,
  getSettings: mockGetSettings,
  validateApiKey: vi.fn()
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: ""
  }))
}));

vi.mock("open-sse/services/accountFallback.js", async () => {
  const actual = await import("../../open-sse/services/accountFallback.js");
  return actual;
});

vi.mock("@/shared/constants/providers.js", async () => {
  const actual = await import("../../src/shared/constants/providers.js");
  return actual;
});

describe("Antigravity account state metadata", () => {
  const now = new Date("2026-05-05T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockGetSettings.mockResolvedValue({ fallbackStrategy: "fill-first", providerStrategies: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("markAccountUnavailable persists Antigravity cooldown metadata with precise reset", async () => {
    const resetAtMs = now.getTime() + 90_000;
    mockGetProviderConnections.mockResolvedValue([{ 
      id: "ag-1",
      provider: "antigravity",
      name: "AG Primary",
      providerSpecificData: {
        antigravity: { enabled: true, projectId: "existing-project", lastUsedAt: "old" },
        keepMe: true
      }
    }]);

    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
    const result = await markAccountUnavailable(
      "ag-1",
      { status: 429, reason: "quota_exhausted", retryAfterMs: 90_000, resetsAtMs: resetAtMs },
      "quota exhausted",
      "antigravity",
      "gemini-3-pro"
    );

    const expectedIso = new Date(resetAtMs).toISOString();
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: 90_000 });
    expect(mockUpdateProviderConnection).toHaveBeenCalledWith("ag-1", expect.objectContaining({
      "modelLock_gemini-3-pro": expectedIso,
      testStatus: "unavailable",
      errorCode: 429,
      providerSpecificData: expect.objectContaining({ keepMe: true })
    }));
    const update = mockUpdateProviderConnection.mock.calls[0][1];
    expect(update.providerSpecificData.antigravity).toMatchObject({
      enabled: true,
      projectId: "existing-project",
      cooldownUntil: expectedIso,
      cooldownReason: "quota_exhausted",
      rateLimitResetTimes: { "gemini-3-pro": expectedIso },
      model: "gemini-3-pro",
      lastProviderStatus: 429,
      retryAfterMs: 90_000,
      lastUsedAt: now.toISOString()
    });
  });

  it("getProviderCredentials skips Antigravity accounts requiring reauth", async () => {
    mockGetProviderConnections.mockResolvedValue([
      {
        id: "reauth-1",
        provider: "antigravity",
        isActive: true,
        testStatus: "reauth_required",
        refreshToken: "stale",
        providerSpecificData: { antigravity: { reauthRequired: true } }
      }
    ]);

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const result = await getProviderCredentials("antigravity");

    expect(result).toBeNull();
    expect(mockUpdateProviderConnection).not.toHaveBeenCalled();
  });
});
