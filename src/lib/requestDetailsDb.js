import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";
import { restoreLocalFileFromDrive, scheduleDriveUpload } from "@/lib/driveDb.js";
import { getCurrentUserScopeId, getUserScopeFromContext } from "@/lib/localDb.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;
const MAX_LOCAL_FILE_SIZE = 25 * 1024 * 1024;
const RETENTION_MONTHS = 5;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!global._requestDetailsLocalState) {
  global._requestDetailsLocalState = { scopes: new Map() };
}

const state = global._requestDetailsLocalState;

function sanitizeOwnerId(ownerId) {
  return String(ownerId || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getDbFile(ownerId = null) {
  return path.join(DATA_DIR, ownerId ? `request-details.${sanitizeOwnerId(ownerId)}.local.json` : "request-details.local.json");
}

function getScopeKey(ownerId = null) {
  return ownerId || "__global__";
}

function getScopeState(ownerId = null) {
  const key = getScopeKey(ownerId);
  if (!state.scopes.has(key)) {
    state.scopes.set(key, {
      ownerId,
      file: getDbFile(ownerId),
      data: { records: [] },
      loaded: false,
      writeBuffer: [],
      flushTimer: null,
      isFlushing: false,
    });
  }
  return state.scopes.get(key);
}

async function resolveOwnerId() {
  const scoped = getUserScopeFromContext();
  if (scoped !== null) return scoped;
  return await getCurrentUserScopeId();
}

function getRetentionCutoffTime() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  return cutoff.getTime();
}

function pruneRecords(records) {
  const cutoffTime = getRetentionCutoffTime();
  return records.filter((record) => new Date(record.timestamp || 0).getTime() >= cutoffTime);
}

async function ensureLocalDbLoaded(ownerId = null) {
  const scope = getScopeState(ownerId);
  if (scope.loaded) return scope;
  await restoreLocalFileFromDrive(scope.file).catch(() => false);
  try {
    if (fs.existsSync(scope.file)) {
      const raw = fs.readFileSync(scope.file, "utf8");
      const parsed = JSON.parse(raw || "{}");
      scope.data = parsed && typeof parsed === "object" ? parsed : { records: [] };
    }
  } catch {
    scope.data = { records: [] };
  }
  if (!Array.isArray(scope.data.records)) scope.data.records = [];
  scope.data.records = pruneRecords(scope.data.records);
  scope.loaded = true;
  return scope;
}

function persistLocalDb(ownerId = null) {
  const scope = getScopeState(ownerId);
  const payload = JSON.stringify(scope.data);
  fs.writeFileSync(scope.file, payload, "utf8");
  scheduleDriveUpload(scope.file);
}

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

async function flushToDatabase(ownerId = null) {
  const scope = getScopeState(ownerId);
  if (scope.isFlushing || scope.writeBuffer.length === 0) return;
  scope.isFlushing = true;
  try {
    await ensureLocalDbLoaded(ownerId);
    const itemsToSave = [...scope.writeBuffer];
    scope.writeBuffer = [];
    const config = await getObservabilityConfig();

    for (const item of itemsToSave) {
      if (!item.id) item.id = generateDetailId(item.model);
      if (!item.timestamp) item.timestamp = new Date().toISOString();
      if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

      const record = {
        id: item.id,
        ownerId: ownerId || null,
        provider: item.provider || null,
        model: item.model || null,
        connectionId: item.connectionId || null,
        timestamp: item.timestamp,
        status: item.status || null,
        latency: item.latency || {},
        tokens: item.tokens || {},
        request: item.request || {},
        providerRequest: item.providerRequest || {},
        providerResponse: item.providerResponse || {},
        response: item.response || {},
      };

      const maxSize = config.maxJsonSize;
      for (const field of ["request", "providerRequest", "providerResponse", "response"]) {
        const str = JSON.stringify(record[field]);
        if (str.length > maxSize) {
          record[field] = { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
        }
      }

      const idx = scope.data.records.findIndex((r) => r.id === record.id);
      if (idx !== -1) scope.data.records[idx] = record;
      else scope.data.records.push(record);
    }

    scope.data.records = pruneRecords(scope.data.records);
    scope.data.records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (scope.data.records.length > config.maxRecords) {
      scope.data.records = scope.data.records.slice(0, config.maxRecords);
    }

    while (scope.data.records.length > 1) {
      const totalSize = Buffer.byteLength(JSON.stringify(scope.data), "utf8");
      if (totalSize <= MAX_LOCAL_FILE_SIZE) break;
      scope.data.records = scope.data.records.slice(0, Math.floor(scope.data.records.length / 2));
    }

    persistLocalDb(ownerId);
  } catch (error) {
    console.error("[requestDetailsDb] Local batch write failed:", error);
  } finally {
    scope.isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  const ownerId = await resolveOwnerId();
  const scope = getScopeState(ownerId);
  detail.ownerId = ownerId || null;
  scope.writeBuffer.push(detail);

  if (scope.writeBuffer.length >= config.batchSize) {
    await flushToDatabase(ownerId);
    if (scope.flushTimer) {
      clearTimeout(scope.flushTimer);
      scope.flushTimer = null;
    }
  } else if (!scope.flushTimer) {
    scope.flushTimer = setTimeout(() => {
      flushToDatabase(ownerId).catch(() => {});
      scope.flushTimer = null;
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const ownerId = await resolveOwnerId();
  const scope = await ensureLocalDbLoaded(ownerId);
  let records = [...scope.data.records];

  if (filter.provider) records = records.filter((r) => r.provider === filter.provider);
  if (filter.model) records = records.filter((r) => r.model === filter.model);
  if (filter.connectionId) records = records.filter((r) => r.connectionId === filter.connectionId);
  if (filter.status) records = records.filter((r) => r.status === filter.status);
  if (filter.startDate) records = records.filter((r) => new Date(r.timestamp) >= new Date(filter.startDate));
  if (filter.endDate) records = records.filter((r) => new Date(r.timestamp) <= new Date(filter.endDate));

  records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const totalItems = records.length;
  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const details = records.slice((page - 1) * pageSize, page * pageSize);

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const ownerId = await resolveOwnerId();
  const scope = await ensureLocalDbLoaded(ownerId);
  return scope.data.records.find((r) => r.id === id) || null;
}

const shutdownHandler = async () => {
  for (const scope of state.scopes.values()) {
    if (scope.flushTimer) {
      clearTimeout(scope.flushTimer);
      scope.flushTimer = null;
    }
    if (scope.writeBuffer.length > 0) await flushToDatabase(scope.ownerId || null);
  }
};

process.off("beforeExit", shutdownHandler);
process.off("SIGINT", shutdownHandler);
process.off("SIGTERM", shutdownHandler);
process.off("exit", shutdownHandler);
process.on("beforeExit", shutdownHandler);
process.on("SIGINT", shutdownHandler);
process.on("SIGTERM", shutdownHandler);
process.on("exit", shutdownHandler);
