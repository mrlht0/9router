import fs from "node:fs";
import { MongoClient } from "mongodb";
import { Pool } from "pg";
import { isDriveSyncEnabled, loadJsonDocumentFromDrive, writeJsonDocumentToDrive } from "@/lib/driveDb.js";

if (!global._documentDbState) {
  global._documentDbState = {
    pgPools: new Map(),
    activePgUrl: null,
    mongoClient: null,
    mongoConnectPromise: null,
    pgTableReady: new Map(),
    mongoIndexReady: new Map(),
    warnedBackends: new Set(),
    backendStatus: {
      postgres: { enabled: false, connected: false, lastError: null, lastOkAt: 0 },
      mongo: { enabled: false, connected: false, lastError: null, lastOkAt: 0 },
      drive: { enabled: false, connected: false, lastError: null, lastOkAt: 0 },
    },
    warmupPromise: null,
    documentCache: new Map(),
    loggedNamespaces: new Set(),
    lastWarmupLog: "",
    lastConfiguredLog: "",
    roundRobinCursor: new Map(),
  };
}

const state = global._documentDbState;
const DEFAULT_BACKEND_TIMEOUT_MS = Number(process.env.DOCUMENT_DB_TIMEOUT_MS || 3000);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function isDefaultDocumentData(data, defaultData) {
  return stableStringify(data) === stableStringify(defaultData);
}

async function loadFromBackend(backend, namespace, defaultData, seedFilePath, seedFromFile) {
  if (backend === "postgres") {
    return await withTimeout(loadFromPostgres(namespace, defaultData, seedFilePath, seedFromFile), "PostgreSQL load");
  }
  if (backend === "mongo") {
    return await withTimeout(loadFromMongo(namespace, defaultData, seedFilePath, seedFromFile), "MongoDB load");
  }
  if (backend === "drive") {
    return await withTimeout(loadFromDrive(namespace, defaultData), "Drive load");
  }
  throw new Error(`Unsupported document database backend: ${backend}`);
}
function cloneDefaultData(defaultData) {
  if (typeof structuredClone === "function") {
    return structuredClone(defaultData);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

function getConfiguredPostgresUrls() {
  const values = [process.env.DATABASE_URL, process.env.DATABASE_URL_1, process.env.POSTGRES_URL]
    .map((value) => String(value || "").trim())
    .filter((value) => /^postgres(ql)?:\/\//i.test(value));
  return [...new Set(values)];
}

function getDatabaseUrl() {
  return getConfiguredPostgresUrls()[0] || "";
}

function getMongoUrl() {
  return process.env.MONGODB_URL || process.env.MONGODB_URI || "";
}

export function isPostgresEnabled() {
  return getConfiguredPostgresUrls().length > 0;
}

export function isMongoEnabled() {
  return /^mongodb(\+srv)?:\/\//i.test(getMongoUrl());
}

export function isDriveEnabled() {
  return isDriveSyncEnabled();
}

export function requirePostgres() {
  const value = getDatabaseUrl();
  if (!value) {
    throw new Error("PostgreSQL is required. Set DATABASE_URL=postgresql://user:password@host:5432/dbname");
  }
  return value;
}

export function getPostgresConnectionString() {
  return requirePostgres();
}

export function getPostgresConnectionStrings() {
  return getConfiguredPostgresUrls();
}

export function requireMongo() {
  const value = getMongoUrl();
  if (!/^mongodb(\+srv)?:\/\//i.test(value)) {
    throw new Error("MongoDB is required. Set MONGODB_URL=mongodb://user:password@host:27017/dbname or MONGODB_URI");
  }
  return value;
}

function withTimeout(promise, label, timeoutMs = DEFAULT_BACKEND_TIMEOUT_MS) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function markBackendOk(name) {
  state.backendStatus[name] = {
    ...state.backendStatus[name],
    enabled: true,
    connected: true,
    lastError: null,
    lastOkAt: Date.now(),
  };
}

function markBackendError(name, error) {
  state.backendStatus[name] = {
    ...state.backendStatus[name],
    enabled: true,
    connected: false,
    lastError: error?.message || String(error),
  };
}

function warnBackendOnce(key, error) {
  if (state.warnedBackends.has(key)) return;
  state.warnedBackends.add(key);
  console.warn(`[DocumentDB] ${key}: ${error.message}`);
}

function formatBackendStatus(name) {
  const status = state.backendStatus[name];
  if (!status?.enabled) return `${name}=disabled`;
  if (status.connected) return `${name}=connected`;
  return `${name}=unavailable${status.lastError ? ` (${status.lastError})` : ""}`;
}

function logWarmupStatus() {
  const message = [
    `[DocumentDB] startup timeout=${DEFAULT_BACKEND_TIMEOUT_MS}ms`,
    formatBackendStatus("postgres"),
    formatBackendStatus("mongo"),
    formatBackendStatus("drive"),
  ].join(" | ");
  if (state.lastWarmupLog === message) return;
  state.lastWarmupLog = message;
  console.log(message);
}

function logNamespaceSelection(namespace, backend, preferredBackends, syncBackends) {
  const key = `${namespace}:${preferredBackends.join(">")}:${syncBackends}:${backend}`;
  if (state.loggedNamespaces.has(key)) return;
  state.loggedNamespaces.add(key);
  console.log(`[DocumentDB] namespace=${namespace} active=${backend} preferred=${preferredBackends.join(">")} sync=${syncBackends}`);
}

function getOrCreatePgPool(connectionString) {
  if (!state.pgPools.has(connectionString)) {
    const pool = new Pool({
      connectionString,
      connectionTimeoutMillis: DEFAULT_BACKEND_TIMEOUT_MS,
      query_timeout: DEFAULT_BACKEND_TIMEOUT_MS,
      ssl: connectionString.includes("supabase.com")
        ? { rejectUnauthorized: false }
        : undefined,
    });
    pool.on("error", (error) => {
      markBackendError("postgres", error);
      warnBackendOnce(`PostgreSQL pool error (${connectionString})`, error);
    });
    state.pgPools.set(connectionString, pool);
  }
  return state.pgPools.get(connectionString);
}

async function queryPostgres(statement, params = []) {
  const urls = getConfiguredPostgresUrls();
  if (!urls.length) {
    throw new Error("PostgreSQL is required. Set DATABASE_URL or DATABASE_URL_1.");
  }
  const orderedUrls = state.activePgUrl && urls.includes(state.activePgUrl)
    ? [state.activePgUrl, ...urls.filter((url) => url !== state.activePgUrl)]
    : urls;
  const errors = [];
  for (const connectionString of orderedUrls) {
    try {
      const pool = getOrCreatePgPool(connectionString);
      const result = await withTimeout(pool.query(statement, params), `PostgreSQL query (${connectionString})`);
      if (state.activePgUrl !== connectionString) {
        console.log(`[DocumentDB] postgres failover active=${connectionString}`);
      }
      state.activePgUrl = connectionString;
      markBackendOk("postgres");
      return result;
    } catch (error) {
      markBackendError("postgres", error);
      errors.push(`${connectionString}: ${error.message}`);
      warnBackendOnce(`PostgreSQL query failed (${connectionString})`, error);
    }
  }
  throw new Error(`All PostgreSQL connections failed. ${errors.join(" | ")}`);
}

function getPgPool() {
  return {
    query(statement, params) {
      return queryPostgres(statement, params);
    },
  };
}

export function getSharedPgPool() {
  return getPgPool();
}

export async function getSharedMongoDb() {
  const client = await getMongoClient();
  return client.db(getMongoDbName());
}

function getMongoDbName() {
  const mongoUrl = requireMongo();
  try {
    const parsed = new URL(mongoUrl);
    const pathname = parsed.pathname.replace(/^\/+/, "").trim();
    if (pathname) return decodeURIComponent(pathname);
  } catch {
    // Ignore parse failures and use env/default below.
  }
  return String(process.env.MONGODB_DB || "9router").trim() || "9router";
}

async function getMongoClient() {
  if (state.mongoClient) return state.mongoClient;
  if (!state.mongoConnectPromise) {
    state.mongoClient = new MongoClient(requireMongo(), {
      serverSelectionTimeoutMS: DEFAULT_BACKEND_TIMEOUT_MS,
      connectTimeoutMS: DEFAULT_BACKEND_TIMEOUT_MS,
    });
    state.mongoConnectPromise = state.mongoClient.connect()
      .then((client) => {
        state.mongoClient = client;
        return client;
      })
      .catch((error) => {
        state.mongoClient = null;
        throw error;
      })
      .finally(() => {
        state.mongoConnectPromise = null;
      });
  }
  return state.mongoConnectPromise;
}

async function ensurePgTable(namespace) {
  if (state.pgTableReady.has(namespace)) return;
  await queryPostgres(`
    CREATE TABLE IF NOT EXISTS app_documents (
      namespace TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  state.pgTableReady.set(namespace, true);
}

async function ensureMongoIndex(collectionName) {
  if (state.mongoIndexReady.has(collectionName)) return;
  const client = await getMongoClient();
  await client.db(getMongoDbName()).collection(collectionName).createIndex({ namespace: 1 }, { unique: true });
  state.mongoIndexReady.set(collectionName, true);
}

async function readSeedFile(seedFilePath, defaultData, seedFromFile) {
  if (!seedFromFile || !seedFilePath || !fs.existsSync(seedFilePath)) {
    return cloneDefaultData(defaultData);
  }

  try {
    const raw = fs.readFileSync(seedFilePath, "utf8");
    if (!raw.trim()) return cloneDefaultData(defaultData);
    return JSON.parse(raw);
  } catch {
    return cloneDefaultData(defaultData);
  }
}

async function probePostgres() {
  if (!isPostgresEnabled()) return false;
  state.backendStatus.postgres.enabled = true;
  try {
    await queryPostgres("SELECT 1");
    markBackendOk("postgres");
    return true;
  } catch (error) {
    markBackendError("postgres", error);
    warnBackendOnce("PostgreSQL unavailable", error);
    return false;
  }
}

async function probeMongo() {
  if (!isMongoEnabled()) return false;
  state.backendStatus.mongo.enabled = true;
  try {
    const client = await withTimeout(getMongoClient(), "MongoDB connect");
    await withTimeout(client.db(getMongoDbName()).command({ ping: 1 }), "MongoDB probe");
    markBackendOk("mongo");
    return true;
  } catch (error) {
    markBackendError("mongo", error);
    warnBackendOnce("MongoDB unavailable", error);
    return false;
  }
}

async function warmBackends() {
  if (!state.warmupPromise) {
    const configuredMessage = `[DocumentDB] startup configured postgres=${isPostgresEnabled() ? "enabled" : "disabled"} mongo=${isMongoEnabled() ? "enabled" : "disabled"} drive=${isDriveEnabled() ? "enabled" : "disabled"} timeout=${DEFAULT_BACKEND_TIMEOUT_MS}ms`;
    if (state.lastConfiguredLog !== configuredMessage) {
      state.lastConfiguredLog = configuredMessage;
      console.log(configuredMessage);
    }
    state.warmupPromise = (async () => {
      await Promise.allSettled([probePostgres(), probeMongo(), probeDrive()]);
      logWarmupStatus();
    })().finally(() => {
      state.warmupPromise = null;
    });
  }
  return state.warmupPromise;
}

export async function warmDocumentDbBackends() {
  await warmBackends();
  return {
    postgres: { ...state.backendStatus.postgres },
    mongo: { ...state.backendStatus.mongo },
    drive: { ...state.backendStatus.drive },
  };
}

function getRoundRobinOrder(namespace, backends) {
  if (!Array.isArray(backends) || backends.length <= 1) return [...backends];
  const cursor = state.roundRobinCursor.get(namespace) || 0;
  const start = cursor % backends.length;
  const ordered = backends.slice(start).concat(backends.slice(0, start));
  state.roundRobinCursor.set(namespace, (cursor + 1) % backends.length);
  return ordered;
}

function normalizeBackendList(preferredBackends) {
  const configured = [];
  if (isPostgresEnabled()) configured.push("postgres");
  if (isMongoEnabled()) configured.push("mongo");
  if (isDriveEnabled()) configured.push("drive");

  const requested = Array.isArray(preferredBackends) && preferredBackends.length > 0
    ? preferredBackends
    : ["postgres", "mongo"];

  const ordered = [];
  for (const backend of requested) {
    if (configured.includes(backend) && !ordered.includes(backend)) ordered.push(backend);
  }
  for (const backend of configured) {
    if (!ordered.includes(backend)) ordered.push(backend);
  }
  return ordered;
}

function getPreferredBackendOrder(namespace, preferredBackends, balanceBackends = false) {
  const baseOrder = normalizeBackendList(preferredBackends);
  const primaryBackends = baseOrder.filter((backend) => backend !== "drive");
  const backupBackends = baseOrder.filter((backend) => backend === "drive");
  const rotatedPrimary = balanceBackends ? getRoundRobinOrder(namespace, primaryBackends) : [...primaryBackends];
  const order = [...rotatedPrimary, ...backupBackends];

  order.sort((a, b) => {
    const aConnected = state.backendStatus[a]?.connected ? 1 : 0;
    const bConnected = state.backendStatus[b]?.connected ? 1 : 0;
    if (aConnected !== bConnected) return bConnected - aConnected;
    return baseOrder.indexOf(a) - baseOrder.indexOf(b);
  });

  return order;
}

async function loadFromPostgres(namespace, defaultData, seedFilePath = "", seedFromFile = false) {
  const defaults = cloneDefaultData(defaultData);
  await ensurePgTable(namespace);

  const existing = await queryPostgres(
    "SELECT data FROM app_documents WHERE namespace = $1",
    [namespace]
  );

  if (existing.rowCount === 0) {
    const seedData = await readSeedFile(seedFilePath, defaults, seedFromFile);
    await queryPostgres(
      `INSERT INTO app_documents (namespace, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (namespace) DO NOTHING`,
      [namespace, JSON.stringify(seedData)]
    );
    markBackendOk("postgres");
    return seedData;
  }

  markBackendOk("postgres");
  return existing.rows[0]?.data ?? defaults;
}

async function writeToPostgres(namespace, data) {
  await ensurePgTable(namespace);
  await queryPostgres(
    `INSERT INTO app_documents (namespace, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (namespace) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [namespace, JSON.stringify(data)]
  );
  markBackendOk("postgres");
}

async function loadFromMongo(namespace, defaultData, seedFilePath = "", seedFromFile = false) {
  const defaults = cloneDefaultData(defaultData);
  const collectionName = "app_documents";
  await ensureMongoIndex(collectionName);

  const client = await getMongoClient();
  const collection = client.db(getMongoDbName()).collection(collectionName);
  const existing = await collection.findOne({ namespace });

  if (!existing) {
    const seedData = await readSeedFile(seedFilePath, defaults, seedFromFile);
    await collection.updateOne(
      { namespace },
      {
        $setOnInsert: {
          namespace,
          data: seedData,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
    markBackendOk("mongo");
    return seedData;
  }

  markBackendOk("mongo");
  return existing.data ?? defaults;
}

async function loadFromDrive(namespace, defaultData) {
  const fileName = `app_documents__${namespace}.json`;
  const data = await loadJsonDocumentFromDrive(fileName, cloneDefaultData(defaultData));
  markBackendOk("drive");
  return data ?? cloneDefaultData(defaultData);
}

async function writeToDrive(namespace, data) {
  const fileName = `app_documents__${namespace}.json`;
  await writeJsonDocumentToDrive(fileName, data);
  markBackendOk("drive");
}

async function writeToMongo(namespace, data) {
  const collectionName = "app_documents";
  await ensureMongoIndex(collectionName);

  const client = await getMongoClient();
  const collection = client.db(getMongoDbName()).collection(collectionName);
  await collection.updateOne(
    { namespace },
    {
      $set: {
        data,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );
  markBackendOk("mongo");
}

async function probeDrive() {
  if (!isDriveEnabled()) return false;
  state.backendStatus.drive.enabled = true;
  try {
    markBackendOk("drive");
    return true;
  } catch (error) {
    markBackendError("drive", error);
    warnBackendOnce("Drive unavailable", error);
    return false;
  }
}

async function syncSecondaryBackends(primaryBackend, namespace, data, preferredBackends) {
  const syncTargets = normalizeBackendList(preferredBackends).filter((backend) => backend !== primaryBackend);
  await Promise.allSettled(syncTargets.map(async (backend) => {
    try {
      if (backend === "postgres") {
        await withTimeout(writeToPostgres(namespace, data), `${backend} secondary sync`);
      } else if (backend === "mongo") {
        await withTimeout(writeToMongo(namespace, data), `${backend} secondary sync`);
      } else if (backend === "drive") {
        await withTimeout(writeToDrive(namespace, data), `${backend} secondary sync`);
      }
    } catch (error) {
      markBackendError(backend, error);
      warnBackendOnce(`Secondary sync failed for ${backend}`, error);
    }
  }));
}

export async function createDocumentDb(namespace, defaultData, seedFilePath = "", options = {}) {
  const {
    preferredBackends = ["postgres", "mongo"],
    syncBackends = true,
    seedFromFile = false,
    balanceBackends = false,
  } = options;

  await warmBackends();

  const cacheKey = `${namespace}::${seedFilePath}::${preferredBackends.join(",")}::${syncBackends ? "sync" : "single"}`;
  if (state.documentCache.has(cacheKey)) {
    return state.documentCache.get(cacheKey);
  }

  const errors = [];
  let activeBackend = null;
  let data = null;

  const orderedBackends = getPreferredBackendOrder(namespace, preferredBackends, balanceBackends);

  for (const backend of orderedBackends) {
    try {
      data = await loadFromBackend(backend, namespace, defaultData, seedFilePath, seedFromFile);
      activeBackend = backend;
      break;
    } catch (error) {
      markBackendError(backend, error);
      errors.push(`${backend}: ${error.message}`);
      warnBackendOnce(`${backend} load failed`, error);
    }
  }

  if (activeBackend && syncBackends && isDefaultDocumentData(data, defaultData)) {
    for (const backend of orderedBackends.filter((candidate) => candidate !== activeBackend)) {
      try {
        const candidateData = await loadFromBackend(backend, namespace, defaultData, seedFilePath, seedFromFile);
        if (!isDefaultDocumentData(candidateData, defaultData)) {
          console.log(`[DocumentDB] namespace=${namespace} recovered non-empty data from ${backend}; syncing ${activeBackend}`);
          data = candidateData;
          activeBackend = backend;
          await syncSecondaryBackends(backend, namespace, data, preferredBackends);
          break;
        }
      } catch (error) {
        markBackendError(backend, error);
        warnBackendOnce(`${backend} recovery load failed`, error);
      }
    }
  }

  if (!activeBackend) {
    if (errors.length > 0) {
      throw new Error(`No document database backend available. ${errors.join(" | ")}`);
    }
    throw new Error("No document database configured. Set DATABASE_URL for PostgreSQL or MONGODB_URL for MongoDB.");
  }

  logNamespaceSelection(namespace, activeBackend, preferredBackends, syncBackends);

  const documentHandle = {
    data,
    backend: activeBackend,
    async write() {
      const payload = this.data;
      const orderedBackends = balanceBackends ? getPreferredBackendOrder(namespace, preferredBackends, true) : [this.backend, ...getPreferredBackendOrder(namespace, preferredBackends, false).filter((backend) => backend !== this.backend)];
      const writeErrors = [];

      for (const backend of orderedBackends) {
        try {
          if (backend === "postgres") {
            await withTimeout(writeToPostgres(namespace, payload), "PostgreSQL write");
          } else if (backend === "mongo") {
            await withTimeout(writeToMongo(namespace, payload), "MongoDB write");
          } else if (backend === "drive") {
            await withTimeout(writeToDrive(namespace, payload), "Drive write");
          }

          if (this.backend !== backend) {
            console.log(`[DocumentDB] namespace=${namespace} failover active=${backend}`);
          }
          this.backend = backend;
          if (syncBackends) await syncSecondaryBackends(backend, namespace, payload, preferredBackends);
          return;
        } catch (error) {
          markBackendError(backend, error);
          writeErrors.push(`${backend}: ${error.message}`);
          warnBackendOnce(`${backend} write failed`, error);
        }
      }

      throw new Error(`Failed to persist document. ${writeErrors.join(" | ")}`);
    },
  };

  state.documentCache.set(cacheKey, documentHandle);
  return documentHandle;
}




