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
const DB_FILE = path.join(DATA_DIR, "request-details.local.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!global._requestDetailsLocalState) {
  global._requestDetailsLocalState = {
    data: { records: [] },
    loaded: false,
    writeBuffer: [],
    flushTimer: null,
    isFlushing: false,
  };
}

const state = global._requestDetailsLocalState;

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

async function ensureLocalDbLoaded() {
  if (state.loaded) return;
  await restoreLocalFileFromDrive(DB_FILE).catch(() => false);
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      const parsed = JSON.parse(raw || "{}");
      state.data = parsed && typeof parsed === "object" ? parsed : { records: [] };
    }
  } catch {
    state.data = { records: [] };
  }
  if (!Array.isArray(state.data.records)) state.data.records = [];
  state.data.records = pruneRecords(state.data.records);
  state.loaded = true;
}

function persistLocalDb() {
  const payload = JSON.stringify(state.data);
  fs.writeFileSync(DB_FILE, payload, "utf8");
  scheduleDriveUpload(DB_FILE);
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

async function flushToDatabase() {
  if (state.isFlushing || state.writeBuffer.length === 0) return;
  state.isFlushing = true;
  try {
    await ensureLocalDbLoaded();
    const itemsToSave = [...state.writeBuffer];
    state.writeBuffer = [];
    const config = await getObservabilityConfig();

    for (const item of itemsToSave) {
      if (!item.id) item.id = generateDetailId(item.model);
      if (!item.timestamp) item.timestamp = new Date().toISOString();
      if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

      const record = {
        id: item.id,
        ownerId: item.ownerId || null,
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

      const idx = state.data.records.findIndex((r) => r.id === record.id);
      if (idx !== -1) state.data.records[idx] = record;
      else state.data.records.push(record);
    }

    state.data.records = pruneRecords(state.data.records);
    state.data.records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (state.data.records.length > config.maxRecords) {
      state.data.records = state.data.records.slice(0, config.maxRecords);
    }

    while (state.data.records.length > 1) {
      const totalSize = Buffer.byteLength(JSON.stringify(state.data), "utf8");
      if (totalSize <= MAX_LOCAL_FILE_SIZE) break;
      state.data.records = state.data.records.slice(0, Math.floor(state.data.records.length / 2));
    }

    persistLocalDb();
  } catch (error) {
    console.error("[requestDetailsDb] Local batch write failed:", error);
  } finally {
    state.isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  detail.ownerId = await resolveOwnerId();
  state.writeBuffer.push(detail);

  if (state.writeBuffer.length >= config.batchSize) {
    await flushToDatabase();
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
  } else if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => {
      flushToDatabase().catch(() => {});
      state.flushTimer = null;
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  await ensureLocalDbLoaded();
  const ownerId = await resolveOwnerId();
  let records = [...state.data.records].filter((r) => (r.ownerId || null) === (ownerId || null));

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
  await ensureLocalDbLoaded();
  const ownerId = await resolveOwnerId();
  return state.data.records.find((r) => r.id === id && (r.ownerId || null) === (ownerId || null)) || null;
}

const shutdownHandler = async () => {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.writeBuffer.length > 0) await flushToDatabase();
};

process.off("beforeExit", shutdownHandler);
process.off("SIGINT", shutdownHandler);
process.off("SIGTERM", shutdownHandler);
process.off("exit", shutdownHandler);
process.on("beforeExit", shutdownHandler);
process.on("SIGINT", shutdownHandler);
process.on("SIGTERM", shutdownHandler);
process.on("exit", shutdownHandler);
