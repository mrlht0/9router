import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Antigravity refresh hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a permanent reauth result for Google invalid_grant", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({
        error: "invalid_grant",
        error_description: "Token has been expired or revoked."
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshGoogleToken } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await refreshGoogleToken("refresh-token", "antigravity", null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      permanent: true,
      reason: "reauth_required",
      code: "invalid_grant",
      provider: "antigravity",
      status: 400
    });
    expect(result.message).toContain("Re-authentication required");
  });

  it("does not retry permanent refresh failures", async () => {
    const permanentFailure = {
      ok: false,
      permanent: true,
      reason: "reauth_required",
      code: "invalid_grant"
    };
    const refreshFn = vi.fn().mockResolvedValue(permanentFailure);

    const { refreshWithRetry } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await refreshWithRetry(refreshFn, 3);

    expect(result).toBe(permanentFailure);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});
