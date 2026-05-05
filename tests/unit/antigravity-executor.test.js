import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

function response(status, headers = {}) {
  return {
    status,
    headers: new Headers(headers)
  };
}

describe("AntigravityExecutor.parseError", () => {
  const now = new Date("2026-05-05T12:00:00.000Z");
  let executor;

  beforeEach(() => {
    executor = new AntigravityExecutor();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses long quota reset messages into quota_exhausted and resetsAtMs", () => {
    const parsed = executor.parseError(
      response(429),
      JSON.stringify({
        error: {
          message: "Resource exhausted. Your Antigravity quota will reset after 2h7m23s. Please try later."
        }
      })
    );

    const expectedMs = ((2 * 60 * 60) + (7 * 60) + 23) * 1000;
    expect(parsed.reason).toBe("quota_exhausted");
    expect(parsed.retryable).toBe(false);
    expect(parsed.retryAfterMs).toBe(expectedMs);
    expect(parsed.resetsAtMs).toBe(now.getTime() + expectedMs);
    expect(parsed.message).toContain("quota will reset");
  });

  it("parses Retry-After seconds as a short retryable rate limit", () => {
    const parsed = executor.parseError(
      response(429, { "retry-after": "5" }),
      JSON.stringify({ error: { message: "Too many requests" } })
    );

    expect(parsed.reason).toBe("rate_limit");
    expect(parsed.retryable).toBe(true);
    expect(parsed.retryAfterMs).toBe(5000);
    expect(parsed.resetsAtMs).toBe(now.getTime() + 5000);
  });

  it("parses reset headers and classifies long waits as quota_exhausted", () => {
    const resetAt = now.getTime() + 60_000;
    const parsed = executor.parseError(
      response(429, { "x-ratelimit-reset": String(Math.floor(resetAt / 1000)) }),
      "usage limit reached"
    );

    expect(parsed.reason).toBe("quota_exhausted");
    expect(parsed.retryable).toBe(false);
    expect(parsed.retryAfterMs).toBe(60_000);
    expect(parsed.resetsAtMs).toBe(resetAt);
  });

  it("parses 503 and 529 as model capacity errors", () => {
    const serviceUnavailable = executor.parseError(response(503), "backend unavailable");
    const overloaded = executor.parseError(response(529), "overloaded");

    expect(serviceUnavailable).toMatchObject({ reason: "model_capacity", retryable: true });
    expect(overloaded).toMatchObject({ reason: "model_capacity", retryable: true });
  });
});
