import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockCreateProviderConnection,
  mockGetProviderConnections
} = vi.hoisted(() => ({
  mockCreateProviderConnection: vi.fn(),
  mockGetProviderConnections: vi.fn()
}));

vi.mock("@/models", () => ({
  createProviderConnection: mockCreateProviderConnection,
  getProviderConnections: mockGetProviderConnections
}));

describe("POST /api/cli/providers/antigravity", () => {
  const now = new Date("2026-05-05T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockGetProviderConnections.mockResolvedValue([]);
    mockCreateProviderConnection.mockImplementation(async (payload) => ({
      id: "created-ag",
      ...payload
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts CLI payload and creates an active OAuth Antigravity connection", async () => {
    const { POST } = await import("../../src/app/api/cli/providers/antigravity/route.js");
    const response = await POST(new Request("http://localhost/api/cli/providers/antigravity", {
      method: "POST",
      body: JSON.stringify({
        accessToken: "access-887",
        refreshToken: "refresh-887",
        email: "ag@example.test",
        scope: "openid email",
        projectId: "ag-project",
        expiresIn: 3600
      })
    }));

    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.connection.accessToken).toBeUndefined();
    expect(body.connection.refreshToken).toBeUndefined();
    expect(mockCreateProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "antigravity",
      authType: "oauth",
      name: "ag@example.test",
      email: "ag@example.test",
      accessToken: "access-887",
      refreshToken: "refresh-887",
      expiresIn: 3600,
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      projectId: "ag-project",
      isActive: true,
      testStatus: "active",
      errorCode: null,
      lastError: null,
      lastErrorAt: null,
      providerSpecificData: {
        antigravity: {
          enabled: true,
          projectId: "ag-project",
          reauthRequired: false,
          reauthReason: null,
          reauthRequiredAt: null,
          lastUsedAt: null
        }
      }
    }));
  });

  it("clears stale reauth and cooldown metadata while preserving unrelated Antigravity metadata", async () => {
    mockGetProviderConnections.mockResolvedValue([{ 
      provider: "antigravity",
      authType: "oauth",
      email: "ag@example.test",
      providerSpecificData: {
        antigravity: {
          enabled: true,
          projectId: "old-project",
          cachedContentTokenCount: 123,
          cooldownUntil: "2026-05-06T00:00:00.000Z",
          reauthRequired: true,
          reauthReason: "invalid_grant"
        },
        otherProviderMetadata: "keep"
      }
    }]);

    const { POST } = await import("../../src/app/api/cli/providers/antigravity/route.js");
    await POST(new Request("http://localhost/api/cli/providers/antigravity", {
      method: "POST",
      body: JSON.stringify({
        accessToken: "access-887",
        refreshToken: "refresh-887",
        email: "ag@example.test",
        projectId: "new-project"
      })
    }));

    const payload = mockCreateProviderConnection.mock.calls[0][0];
    expect(payload.providerSpecificData.otherProviderMetadata).toBe("keep");
    expect(payload.providerSpecificData.antigravity).toMatchObject({
      enabled: true,
      projectId: "new-project",
      cachedContentTokenCount: 123,
      reauthRequired: false,
      reauthReason: null,
      reauthRequiredAt: null,
      lastUsedAt: null
    });
    expect(payload.providerSpecificData.antigravity).not.toHaveProperty("cooldownUntil");
  });
});
