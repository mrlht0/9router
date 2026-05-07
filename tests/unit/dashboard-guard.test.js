import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ type: "json", body, status: init?.status || 200 })),
    next: vi.fn(() => ({ type: "next", status: 200 })),
    redirect: vi.fn((url) => ({ type: "redirect", url: String(url), status: 307 })),
  },
}));

vi.mock("jose", () => ({
  jwtVerify: vi.fn(async () => { throw new Error("invalid token"); }),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "cli-token"),
}));

import { getSettings } from "@/lib/localDb";
import { proxy } from "../../src/dashboardGuard.js";

function makeRequest(pathname, host, headers = {}) {
  return {
    nextUrl: { pathname, hostname: host.split(":")[0] },
    headers: new Headers({ host, ...headers }),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://${host}${pathname}`,
  };
}

describe("dashboardGuard management API auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALLOW_UNAUTHENTICATED_REMOTE_MANAGEMENT_API;
    getSettings.mockResolvedValue({ requireLogin: false });
  });

  it("allows localhost management APIs when login is disabled", async () => {
    const response = await proxy(makeRequest("/api/providers", "localhost:20128"));

    expect(response.type).toBe("next");
  });

  it("requires auth for remote management APIs even when login is disabled", async () => {
    const response = await proxy(makeRequest("/api/providers", "example.com"));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("allows remote management APIs with the explicit unsafe opt-in", async () => {
    process.env.ALLOW_UNAUTHENTICATED_REMOTE_MANAGEMENT_API = "true";

    const response = await proxy(makeRequest("/api/providers", "example.com"));

    expect(response.type).toBe("next");
  });

  it("allows remote management APIs with a valid CLI token", async () => {
    const response = await proxy(makeRequest(
      "/api/providers",
      "example.com",
      { "x-9r-cli-token": "cli-token" },
    ));

    expect(response.type).toBe("next");
  });

  it("always protects database settings even on localhost", async () => {
    const response = await proxy(makeRequest("/api/settings/database", "localhost:20128"));

    expect(response.status).toBe(401);
  });
});
