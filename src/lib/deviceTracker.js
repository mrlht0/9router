import crypto from "crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const TTL_ENV_NAME = "DEVICE_TRACKER_TTL_MS";

function parseTtlMs() {
  const rawValue = process.env[TTL_ENV_NAME];
  if (!rawValue) return DEFAULT_TTL_MS;

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    console.warn(`[deviceTracker] Invalid ${TTL_ENV_NAME} value "${rawValue}"; using ${DEFAULT_TTL_MS}ms`);
    return DEFAULT_TTL_MS;
  }

  return parsedValue;
}

const ttlMs = parseTtlMs();

if (!global._apiKeyDeviceTracker) {
  global._apiKeyDeviceTracker = {
    devicesByApiKey: new Map(),
    cleanupTimer: null,
  };
  console.log(`[deviceTracker] Initialized in-memory tracker with TTL ${ttlMs}ms`);
}

const tracker = global._apiKeyDeviceTracker;

function getHeaderValue(request, headerName) {
  return request?.headers?.get?.(headerName)?.trim() || "";
}

function extractIp(request) {
  const forwardedFor = getHeaderValue(request, "x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  return getHeaderValue(request, "x-real-ip")
    || getHeaderValue(request, "cf-connecting-ip")
    || getHeaderValue(request, "fastly-client-ip")
    || "unknown";
}

function extractUserAgent(request) {
  return getHeaderValue(request, "user-agent") || "unknown";
}

function createFingerprint(ip, userAgent) {
  return crypto.createHash("sha256").update(`${ip}|${userAgent}`).digest("hex");
}

function getVisibleCounts() {
  const counts = {};

  for (const [apiKey, devices] of tracker.devicesByApiKey.entries()) {
    counts[apiKey] = devices.size;
  }

  return counts;
}

function countsAreEqual(before, after) {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);

  if (beforeKeys.length !== afterKeys.length) return false;

  for (const apiKey of beforeKeys) {
    if (before[apiKey] !== after[apiKey]) return false;
  }

  return true;
}

function expireDevices(now = Date.now()) {
  let expiredCount = 0;

  for (const [apiKey, devices] of tracker.devicesByApiKey.entries()) {
    for (const [fingerprint, record] of devices.entries()) {
      if (now - record.lastSeen > ttlMs) {
        devices.delete(fingerprint);
        expiredCount += 1;
      }
    }

    if (devices.size === 0) {
      tracker.devicesByApiKey.delete(apiKey);
    }
  }

  if (expiredCount > 0) {
    console.log(`[deviceTracker] Expired ${expiredCount} stale device${expiredCount === 1 ? "" : "s"}`);
  }
}

function emitDeviceCountUpdate() {
  import("@/lib/usageDb.js")
    .then(({ statsEmitter }) => statsEmitter.emit("update"))
    .catch((error) => {
      console.error("[deviceTracker] Failed to emit stats update:", error.message);
    });
}

function expireAndEmitIfChanged(now = Date.now()) {
  const beforeCounts = getVisibleCounts();
  expireDevices(now);
  const afterCounts = getVisibleCounts();

  if (!countsAreEqual(beforeCounts, afterCounts)) {
    emitDeviceCountUpdate();
    return true;
  }

  return false;
}

function ensureCleanupTimer() {
  if (tracker.cleanupTimer) return;

  tracker.cleanupTimer = setInterval(() => {
    expireAndEmitIfChanged();
  }, CLEANUP_INTERVAL_MS);

  tracker.cleanupTimer.unref?.();
}

ensureCleanupTimer();

export function trackDevice(apiKey, request) {
  if (!apiKey || typeof apiKey !== "string") {
    console.warn("[deviceTracker] Skipped tracking because apiKey is missing or invalid");
    return null;
  }

  const now = Date.now();
  const beforeCounts = getVisibleCounts();

  expireDevices(now);

  const ip = extractIp(request);
  const userAgent = extractUserAgent(request);
  const fingerprint = createFingerprint(ip, userAgent);

  let devices = tracker.devicesByApiKey.get(apiKey);
  if (!devices) {
    devices = new Map();
    tracker.devicesByApiKey.set(apiKey, devices);
  }

  const existingRecord = devices.get(fingerprint);
  if (existingRecord) {
    existingRecord.lastSeen = now;
  } else {
    devices.set(fingerprint, { fingerprint, ip, userAgent, lastSeen: now });
    console.log(`[deviceTracker] Tracked new device for API key ${apiKey.slice(0, 8)}...`);
  }

  const afterCounts = getVisibleCounts();
  if (!countsAreEqual(beforeCounts, afterCounts)) {
    emitDeviceCountUpdate();
  }

  return fingerprint;
}

export function getDeviceCount(apiKey) {
  expireAndEmitIfChanged();

  if (!apiKey || typeof apiKey !== "string") return 0;

  return tracker.devicesByApiKey.get(apiKey)?.size || 0;
}

export function getDeviceDetails(apiKey) {
  expireAndEmitIfChanged();

  if (!apiKey || typeof apiKey !== "string") return [];

  const devices = tracker.devicesByApiKey.get(apiKey);
  if (!devices) return [];

  return Array.from(devices.values()).map((record) => ({
    fingerprint: record.fingerprint,
    ip: record.ip,
    userAgent: record.userAgent,
    lastSeen: record.lastSeen,
  }));
}

export function getAllDeviceCounts() {
  expireAndEmitIfChanged();
  return { ...getVisibleCounts() };
}
