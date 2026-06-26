import { v4 as uuidv4 } from "uuid";
import path from "node:path";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_DIR } from "@/lib/dataDir.js";
import { createDocumentDb } from "@/lib/documentDb.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DB_FILE = path.join(DATA_DIR, "db.json");
const AUTH_DB_FILE = path.join(DATA_DIR, "auth.json");
const LOCAL_DB_NAMESPACE = "localDb";
const LOCAL_DB_SCOPE_PREFIX = "localDbScope__";
const LOCAL_DB_WRITE_DEBOUNCE_MS = Math.max(0, Number(process.env.LOCAL_DB_WRITE_DEBOUNCE_MS || 25));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  requireLogin: true,
  tunnelDashboardAccess: true,
  observabilityEnabled: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 1024,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  cavemanEnabled: false,
  cavemanLevel: "full",
};

function cloneScopedData() {
  return {
    providerConnections: [],
    providerNodes: [],
    proxyPools: [],
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    combos: [],
    apiKeys: [],
    settings: { ...DEFAULT_SETTINGS },
    pricing: {},
  };
}

function cloneDefaultData() {
  return {
    users: [],
    userData: {},
    ...cloneScopedData(),
  };
}

function cloneAuthData() {
  return { users: [] };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sanitizeScopeKey(value) {
  return String(value || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getScopedNamespace(userId = null) {
  return `${LOCAL_DB_SCOPE_PREFIX}${userId ? `user__${sanitizeScopeKey(userId)}` : "global"}`;
}

function isDefaultScopedData(data) {
  return stableStringify(data) === stableStringify(cloneScopedData());
}


function ensureDbShape(data) {
  const defaults = cloneDefaultData();
  const next = data && typeof data === "object" ? data : {};
  let changed = false;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null) {
      next[key] = defaultValue;
      changed = true;
      continue;
    }

  }

  const normalizeScopedState = (state) => {
    const scopedDefaults = cloneScopedData();
    let scopedChanged = false;
    for (const [key, defaultValue] of Object.entries(scopedDefaults)) {
      if (state[key] === undefined || state[key] === null) {
        state[key] = defaultValue;
        scopedChanged = true;
        continue;
      }

      if (key === "settings" && (typeof state.settings !== "object" || Array.isArray(state.settings))) {
        state.settings = { ...defaultValue };
        scopedChanged = true;
        continue;
      }

      if (key === "settings" && typeof state.settings === "object" && !Array.isArray(state.settings)) {
        for (const [settingKey, settingDefault] of Object.entries(defaultValue)) {
          if (state.settings[settingKey] === undefined) {
            if (
              settingKey === "outboundProxyEnabled" &&
              typeof state.settings.outboundProxyUrl === "string" &&
              state.settings.outboundProxyUrl.trim()
            ) {
              state.settings.outboundProxyEnabled = true;
            } else {
              state.settings[settingKey] = settingDefault;
            }
            scopedChanged = true;
          }
        }
      }

      if (key === "apiKeys" && Array.isArray(state.apiKeys)) {
        for (const apiKey of state.apiKeys) {
          if (apiKey.isActive === undefined || apiKey.isActive === null) {
            apiKey.isActive = true;
            scopedChanged = true;
          }
        }
      }
    }
    return scopedChanged;
  };

  if (typeof next.userData !== "object" || Array.isArray(next.userData)) {
    next.userData = {};
    changed = true;
  }

  if (normalizeScopedState(next)) changed = true;
  for (const scopedState of Object.values(next.userData)) {
    if (scopedState && typeof scopedState === "object" && !Array.isArray(scopedState)) {
      if (normalizeScopedState(scopedState)) changed = true;
    }
  }

  return { data: next, changed };
}

function ensureScopedShape(data) {
  const next = data && typeof data === "object" && !Array.isArray(data) ? data : cloneScopedData();
  const defaults = cloneScopedData();
  let changed = false;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null) {
      next[key] = defaultValue;
      changed = true;
      continue;
    }

    if (key === "settings" && (typeof next.settings !== "object" || Array.isArray(next.settings))) {
      next.settings = { ...defaultValue };
      changed = true;
      continue;
    }

    if (key === "settings" && typeof next.settings === "object" && !Array.isArray(next.settings)) {
      for (const [settingKey, settingDefault] of Object.entries(defaultValue)) {
        if (next.settings[settingKey] === undefined) {
          if (
            settingKey === "outboundProxyEnabled" &&
            typeof next.settings.outboundProxyUrl === "string" &&
            next.settings.outboundProxyUrl.trim()
          ) {
            next.settings.outboundProxyEnabled = true;
          } else {
            next.settings[settingKey] = settingDefault;
          }
          changed = true;
        }
      }
    }

    if (key === "apiKeys" && Array.isArray(next.apiKeys)) {
      for (const apiKey of next.apiKeys) {
        if (apiKey.isActive === undefined || apiKey.isActive === null) {
          apiKey.isActive = true;
          changed = true;
        }
      }
    }
  }

  return { data: next, changed };
}

const userScopeStorage = new AsyncLocalStorage();
let userMutationLock = Promise.resolve();
const pendingWrites = new WeakMap();

async function withUserMutationLock(fn) {
  const previous = userMutationLock;
  let release;
  userMutationLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function runWithUserScope(userId, fn) {
  return await userScopeStorage.run({ userId: userId || null }, fn);
}

export function getUserScopeFromContext() {
  return userScopeStorage.getStore()?.userId || null;
}

export async function getCurrentUserScopeId() {
  return await resolveScopedUserId();
}

async function resolveScopedUserId() {
  const scopedUserId = getUserScopeFromContext();
  if (scopedUserId !== null) return scopedUserId;

  try {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    if (!token) return null;
    const { getDashboardAuthSession } = await import("@/lib/auth/dashboardSession.js");
    const session = await getDashboardAuthSession(token);
    return session?.userId || null;
  } catch {
    return null;
  }
}

async function getScopedDbContext() {
  const userId = await resolveScopedUserId();
  const db = await getScopeDb(userId);
  const scope = db.data;
  return { db, scope, userId };
}

function getAllScopedStates(rootData) {
  const states = [{ ownerId: null, state: rootData }];
  const userData = rootData.userData || {};
  for (const [ownerId, state] of Object.entries(userData)) {
    states.push({ ownerId, state });
  }
  return states;
}

async function safeWrite(db) {
  if (!db?.write) return;
  if (LOCAL_DB_WRITE_DEBOUNCE_MS <= 0) {
    await db.write();
    return;
  }

  const existing = pendingWrites.get(db);
  if (existing) {
    existing.dirty = true;
    return await existing.promise;
  }

  const state = { dirty: false, promise: null };
  state.promise = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        do {
          state.dirty = false;
          await db.write();
        } while (state.dirty);
        pendingWrites.delete(db);
        resolve();
      } catch (error) {
        pendingWrites.delete(db);
        reject(error);
      }
    }, LOCAL_DB_WRITE_DEBOUNCE_MS);
  });

  pendingWrites.set(db, state);
  await state.promise;
}

async function getLegacyConfigDb() {
  const db = await createDocumentDb(LOCAL_DB_NAMESPACE, cloneDefaultData(), DB_FILE, {
    preferredBackends: ["postgres", "mongo"],
    syncBackends: true,
    seedFromFile: false,
    balanceBackends: true,
  });
  const { data, changed } = ensureDbShape(db.data);
  db.data = data;
  if (changed) await db.write();
  return db;
}

async function getScopeDb(userId = null) {
  const db = await createDocumentDb(getScopedNamespace(userId), cloneScopedData(), DB_FILE, {
    preferredBackends: ["postgres", "mongo"],
    syncBackends: true,
    seedFromFile: false,
    balanceBackends: true,
  });
  const { data, changed } = ensureScopedShape(db.data);
  db.data = data;
  if (changed) await db.write();

  if (!isDefaultScopedData(db.data)) return db;

  try {
    const legacyDb = await getLegacyConfigDb();
    const legacyScope = userId ? legacyDb.data?.userData?.[userId] : legacyDb.data;
    if (legacyScope && typeof legacyScope === "object" && !Array.isArray(legacyScope)) {
      const migrated = ensureScopedShape({
        ...cloneScopedData(),
        ...legacyScope,
        settings: {
          ...cloneScopedData().settings,
          ...(legacyScope.settings && typeof legacyScope.settings === "object" && !Array.isArray(legacyScope.settings)
            ? legacyScope.settings
            : {}),
        },
      }).data;
      if (!isDefaultScopedData(migrated)) {
        db.data = migrated;
        await db.write();
      }
    }
  } catch (error) {
    console.warn("[localDb] Legacy scope migration skipped:", error.message);
  }

  return db;
}

async function getAuthDb() {
  const authDb = await createDocumentDb("authDb", cloneAuthData(), AUTH_DB_FILE, {
    preferredBackends: ["mongo", "postgres"],
    syncBackends: true,
    seedFromFile: false,
    balanceBackends: true,
  });
  if (!authDb.data || typeof authDb.data !== "object") authDb.data = cloneAuthData();
  if (!Array.isArray(authDb.data.users)) authDb.data.users = [];

  if (authDb.data.users.length === 0) {
    try {
      const configDb = await getLegacyConfigDb();
      const legacyUsers = Array.isArray(configDb.data?.users) ? configDb.data.users : [];
      if (legacyUsers.length > 0) {
        authDb.data.users = legacyUsers;
        await safeWrite(authDb);
        console.log(`[AuthDB] migrated ${legacyUsers.length} user(s) from localDb.users to authDb.users`);
      }
    } catch (error) {
      console.warn("[AuthDB] legacy user migration skipped:", error.message);
    }
  }

  return authDb;
}
export async function getDb() {
  const [authDb, globalDb] = await Promise.all([getAuthDb(), getScopeDb(null)]);
  const aggregate = {
    users: Array.isArray(authDb.data?.users) ? [...authDb.data.users] : [],
    userData: {},
    ...cloneScopedData(),
  };
  Object.assign(aggregate, JSON.parse(JSON.stringify(globalDb.data || cloneScopedData())));

  for (const user of aggregate.users) {
    const scopedDb = await getScopeDb(user.id);
    aggregate.userData[user.id] = JSON.parse(JSON.stringify(scopedDb.data || cloneScopedData()));
  }

  return {
    data: aggregate,
    backend: "segmented",
    async write() {
      throw new Error("Aggregate localDb view is read-only; write through scoped APIs");
    },
  };
}

export async function getProviderConnections(filter = {}) {
  const { scope } = await getScopedDbContext();
  let connections = scope.providerConnections || [];

  if (filter.provider) connections = connections.filter(c => c.provider === filter.provider);
  if (filter.isActive !== undefined) connections = connections.filter(c => c.isActive === filter.isActive);

  connections.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return connections;
}

export async function getProviderNodes(filter = {}) {
  const { scope } = await getScopedDbContext();
  let nodes = scope.providerNodes || [];
  if (filter.type) nodes = nodes.filter((node) => node.type === filter.type);
  return nodes;
}

export async function getProviderNodeById(id) {
  const { scope } = await getScopedDbContext();
  return scope.providerNodes.find((node) => node.id === id) || null;
}

export async function createProviderNode(data) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.providerNodes) scope.providerNodes = [];

  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };

  scope.providerNodes.push(node);
  await safeWrite(db);
  return node;
}

export async function updateProviderNode(id, data) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.providerNodes) scope.providerNodes = [];

  const index = scope.providerNodes.findIndex((node) => node.id === id);
  if (index === -1) return null;

  scope.providerNodes[index] = {
    ...scope.providerNodes[index],
    ...data,
    updatedAt: new Date().toISOString(),
  };

  await safeWrite(db);
  return scope.providerNodes[index];
}

export async function deleteProviderNode(id) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.providerNodes) scope.providerNodes = [];

  const index = scope.providerNodes.findIndex((node) => node.id === id);
  if (index === -1) return null;

  const [removed] = scope.providerNodes.splice(index, 1);
  await safeWrite(db);
  return removed;
}

export async function getProxyPools(filter = {}) {
  const { scope } = await getScopedDbContext();
  let pools = scope.proxyPools || [];

  if (filter.isActive !== undefined) pools = pools.filter((pool) => pool.isActive === filter.isActive);
  if (filter.testStatus) pools = pools.filter((pool) => pool.testStatus === filter.testStatus);

  return pools.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function getProxyPoolById(id) {
  const { scope } = await getScopedDbContext();
  return (scope.proxyPools || []).find((pool) => pool.id === id) || null;
}

export async function createProxyPool(data) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.proxyPools) scope.proxyPools = [];

  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    relaySecret: data.relaySecret || "",
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };

  scope.proxyPools.push(pool);
  await safeWrite(db);
  return pool;
}

export async function updateProxyPool(id, data) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.proxyPools) scope.proxyPools = [];

  const index = scope.proxyPools.findIndex((pool) => pool.id === id);
  if (index === -1) return null;

  scope.proxyPools[index] = {
    ...scope.proxyPools[index],
    ...data,
    updatedAt: new Date().toISOString(),
  };

  await safeWrite(db);
  return scope.proxyPools[index];
}

export async function deleteProxyPool(id) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.proxyPools) scope.proxyPools = [];

  const index = scope.proxyPools.findIndex((pool) => pool.id === id);
  if (index === -1) return null;

  const [removed] = scope.proxyPools.splice(index, 1);
  await safeWrite(db);
  return removed;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const { db, scope } = await getScopedDbContext();
  const beforeCount = scope.providerConnections.length;
  scope.providerConnections = scope.providerConnections.filter(
    (connection) => connection.provider !== providerId
  );
  const deletedCount = beforeCount - scope.providerConnections.length;
  await safeWrite(db);
  return deletedCount;
}

export async function getProviderConnectionById(id) {
  const { scope } = await getScopedDbContext();
  return scope.providerConnections.find(c => c.id === id) || null;
}

export async function createProviderConnection(data) {
  const { db, scope } = await getScopedDbContext();
  const now = new Date().toISOString();

  // Upsert: check existing by provider + email (oauth) or provider + name (apikey)
  let existingIndex = -1;
  if (data.authType === "oauth" && data.email) {
    existingIndex = scope.providerConnections.findIndex(
      c => c.provider === data.provider && c.authType === "oauth" && c.email === data.email
    );
  } else if (data.authType === "apikey" && data.name) {
    existingIndex = scope.providerConnections.findIndex(
      c => c.provider === data.provider && c.authType === "apikey" && c.name === data.name
    );
  }

  if (existingIndex !== -1) {
    scope.providerConnections[existingIndex] = {
      ...scope.providerConnections[existingIndex],
      ...data,
      updatedAt: now,
    };
    await safeWrite(db);
    return scope.providerConnections[existingIndex];
  }

  let connectionName = data.name || null;
  if (!connectionName && data.authType === "oauth") {
    if (data.email) {
      connectionName = data.email;
    } else {
      const existingCount = scope.providerConnections.filter(
        c => c.provider === data.provider
      ).length;
      connectionName = `Account ${existingCount + 1}`;
    }
  }

  let connectionPriority = data.priority;
  if (!connectionPriority) {
    const providerConnections = scope.providerConnections.filter(c => c.provider === data.provider);
    const maxPriority = providerConnections.reduce((max, c) => Math.max(max, c.priority || 0), 0);
    connectionPriority = maxPriority + 1;
  }

  const connection = {
    id: uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name: connectionName,
    priority: connectionPriority,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
  };

  const optionalFields = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
    "consecutiveUseCount"
  ];

  for (const field of optionalFields) {
    if (data[field] !== undefined && data[field] !== null) {
      connection[field] = data[field];
    }
  }

  if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
    connection.providerSpecificData = data.providerSpecificData;
  }

  scope.providerConnections.push(connection);
  await safeWrite(db);
  await reorderProviderConnections(data.provider);

  return connection;
}

export async function updateProviderConnection(id, data) {
  const { db, scope } = await getScopedDbContext();
  const index = scope.providerConnections.findIndex(c => c.id === id);
  if (index === -1) return null;

  const providerId = scope.providerConnections[index].provider;

  scope.providerConnections[index] = {
    ...scope.providerConnections[index],
    ...data,
    updatedAt: new Date().toISOString(),
  };

  await safeWrite(db);
  if (data.priority !== undefined) await reorderProviderConnections(providerId);

  return scope.providerConnections[index];
}

export async function deleteProviderConnection(id) {
  const { db, scope } = await getScopedDbContext();
  const index = scope.providerConnections.findIndex(c => c.id === id);
  if (index === -1) return false;

  const providerId = scope.providerConnections[index].provider;
  scope.providerConnections.splice(index, 1);
  await safeWrite(db);
  await reorderProviderConnections(providerId);

  return true;
}

export async function reorderProviderConnections(providerId) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.providerConnections) return;

  const providerConnections = scope.providerConnections
    .filter(c => c.provider === providerId)
    .sort((a, b) => {
      const pDiff = (a.priority || 0) - (b.priority || 0);
      if (pDiff !== 0) return pDiff;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });

  providerConnections.forEach((conn, index) => {
    conn.priority = index + 1;
  });

  await safeWrite(db);
}

export async function getModelAliases() {
  const { scope } = await getScopedDbContext();
  return scope.modelAliases || {};
}

export async function setModelAlias(alias, model) {
  const { db, scope } = await getScopedDbContext();
  scope.modelAliases[alias] = model;
  await safeWrite(db);
}

export async function deleteModelAlias(alias) {
  const { db, scope } = await getScopedDbContext();
  delete scope.modelAliases[alias];
  await safeWrite(db);
}

// Custom models — user-added models with explicit type (llm/image/tts/embedding/...)
export async function getCustomModels() {
  const { scope } = await getScopedDbContext();
  return scope.customModels || [];
}

export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.customModels) scope.customModels = [];
  const exists = scope.customModels.some(
    (m) => m.providerAlias === providerAlias && m.id === id && (m.type || "llm") === type
  );
  if (exists) return false;
  scope.customModels.push({ providerAlias, id, type, name: name || id });
  await safeWrite(db);
  return true;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.customModels) return;
  scope.customModels = scope.customModels.filter(
    (m) => !(m.providerAlias === providerAlias && m.id === id && (m.type || "llm") === type)
  );
  await safeWrite(db);
}

export async function getMitmAlias(toolName) {
  const { scope } = await getScopedDbContext();
  const all = scope.mitmAlias || {};
  if (toolName) return all[toolName] || {};
  return all;
}

export async function setMitmAliasAll(toolName, mappings) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.mitmAlias) scope.mitmAlias = {};
  scope.mitmAlias[toolName] = mappings || {};
  await safeWrite(db);
}

export async function getCombos() {
  const { scope } = await getScopedDbContext();
  return scope.combos || [];
}

export async function getComboById(id) {
  const { scope } = await getScopedDbContext();
  return (scope.combos || []).find(c => c.id === id) || null;
}

export async function getComboByName(name) {
  const { scope } = await getScopedDbContext();
  return (scope.combos || []).find(c => c.name === name) || null;
}

export async function createCombo(data) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.combos) scope.combos = [];

  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    models: data.models || [],
    kind: data.kind || null,
    createdAt: now,
    updatedAt: now,
  };

  scope.combos.push(combo);
  await safeWrite(db);
  return combo;
}

export async function updateCombo(id, data) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.combos) scope.combos = [];

  const index = scope.combos.findIndex(c => c.id === id);
  if (index === -1) return null;

  scope.combos[index] = {
    ...scope.combos[index],
    ...data,
    updatedAt: new Date().toISOString(),
  };

  await safeWrite(db);
  return scope.combos[index];
}

export async function deleteCombo(id) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.combos) return false;

  const index = scope.combos.findIndex(c => c.id === id);
  if (index === -1) return false;

  scope.combos.splice(index, 1);
  await safeWrite(db);
  return true;
}

export async function getApiKeys() {
  const { scope } = await getScopedDbContext();
  return scope.apiKeys || [];
}

function generateShortKey() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");

  const { db, scope, userId } = await getScopedDbContext();
  const now = new Date().toISOString();

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);

  const apiKey = {
    id: uuidv4(),
    name: name,
    key: result.key,
    ownerId: userId || null,
    machineId: machineId,
    isActive: true,
    createdAt: now,
  };

  scope.apiKeys.push(apiKey);
  await safeWrite(db);
  return apiKey;
}

export async function deleteApiKey(id) {
  const { db, scope } = await getScopedDbContext();
  const index = scope.apiKeys.findIndex(k => k.id === id);
  if (index === -1) return false;

  scope.apiKeys.splice(index, 1);
  await safeWrite(db);
  return true;
}

export async function getApiKeyById(id) {
  const { scope } = await getScopedDbContext();
  return scope.apiKeys.find(k => k.id === id) || null;
}

export async function updateApiKey(id, data) {
  const { db, scope } = await getScopedDbContext();
  const index = scope.apiKeys.findIndex(k => k.id === id);
  if (index === -1) return null;
  scope.apiKeys[index] = { ...scope.apiKeys[index], ...data };
  await safeWrite(db);
  return scope.apiKeys[index];
}

export async function validateApiKey(key) {
  const record = await getApiKeyRecord(key);
  return record && record.isActive !== false;
}

export async function getApiKeyRecord(key) {
  const globalDb = await getScopeDb(null);
  for (const apiKey of globalDb.data.apiKeys || []) {
    if (apiKey.key === key) return { ...apiKey, ownerId: apiKey.ownerId ?? null };
  }

  const users = await getUsers();
  for (const user of users) {
    const scopedDb = await getScopeDb(user.id);
    const found = (scopedDb.data.apiKeys || []).find((apiKey) => apiKey.key === key);
    if (found) {
      return { ...found, ownerId: found.ownerId ?? user.id ?? null };
    }
  }
  return null;
}

export async function getApiKeyOwnerId(key) {
  const record = await getApiKeyRecord(key);
  return record?.ownerId || null;
}

export async function cleanupProviderConnections() {
  const { db, scope } = await getScopedDbContext();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount"
  ];

  let cleaned = 0;
  for (const connection of scope.providerConnections) {
    for (const field of fieldsToCheck) {
      if (connection[field] === null || connection[field] === undefined) {
        delete connection[field];
        cleaned++;
      }
    }
    if (connection.providerSpecificData && Object.keys(connection.providerSpecificData).length === 0) {
      delete connection.providerSpecificData;
      cleaned++;
    }
  }

  if (cleaned > 0) await safeWrite(db);
  return cleaned;
}

function normalizeUserEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function getUsers() {
  const db = await getAuthDb();
  return Array.isArray(db.data.users) ? db.data.users : [];
}

export async function getUserById(id) {
  const users = await getUsers();
  return users.find((user) => user.id === id) || null;
}

export async function getUserByEmail(email) {
  const normalizedEmail = normalizeUserEmail(email);
  if (!normalizedEmail) return null;
  const users = await getUsers();
  return users.find((user) => normalizeUserEmail(user.email) === normalizedEmail) || null;
}

export async function createUser(data = {}) {
  return await withUserMutationLock(async () => {
    const db = await getAuthDb();
    if (!Array.isArray(db.data.users)) db.data.users = [];

    const email = normalizeUserEmail(data.email);
    if (!email) throw new Error("Email is required");
    if (!data.passwordHash) throw new Error("passwordHash is required");
    if (data.bootstrapOnly === true && db.data.users.length > 0) {
      throw new Error("Bootstrap registration already completed");
    }
    if (db.data.users.some((user) => normalizeUserEmail(user.email) === email)) {
      throw new Error("Email already exists");
    }

    const now = new Date().toISOString();
    const user = {
      id: data.id || uuidv4(),
      email,
      passwordHash: data.passwordHash,
      name: String(data.name || "").trim() || null,
      isActive: data.isActive !== false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };

    db.data.users.push(user);
    await safeWrite(db);

    try {
      const configDb = await getScopeDb(user.id);
      await safeWrite(configDb);
    } catch (error) {
      console.warn("[localDb] Failed to initialize user config scope:", error.message);
    }
    return user;
  });
}

export async function updateUser(id, updates = {}) {
  const db = await getAuthDb();
  if (!Array.isArray(db.data.users)) db.data.users = [];

  const index = db.data.users.findIndex((user) => user.id === id);
  if (index === -1) return null;

  const next = { ...updates };
  if (Object.prototype.hasOwnProperty.call(next, "email")) {
    const email = normalizeUserEmail(next.email);
    if (!email) throw new Error("Email is required");
    const duplicate = db.data.users.find((user, userIndex) => userIndex !== index && normalizeUserEmail(user.email) === email);
    if (duplicate) throw new Error("Email already exists");
    next.email = email;
  }

  db.data.users[index] = {
    ...db.data.users[index],
    ...next,
    updatedAt: new Date().toISOString(),
  };

  await safeWrite(db);
  return db.data.users[index];
}

export async function getSettings() {
  const { scope } = await getScopedDbContext();
  return scope.settings || { cloudEnabled: false };
}

export async function updateSettings(updates) {
  const { db, scope } = await getScopedDbContext();
  scope.settings = { ...scope.settings, ...updates };
  await safeWrite(db);
  return scope.settings;
}

export async function exportDb() {
  const { scope } = await getScopedDbContext();
  return JSON.parse(JSON.stringify(scope || cloneScopedData()));
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }

  const nextData = {
    ...cloneScopedData(),
    ...payload,
    settings: {
      ...cloneScopedData().settings,
      ...(payload.settings && typeof payload.settings === "object" && !Array.isArray(payload.settings)
        ? payload.settings
        : {}),
    },
  };

  const normalized = { ...cloneScopedData(), ...nextData };
  const { db, scope } = await getScopedDbContext();
  Object.assign(scope, normalized);
  await safeWrite(db);
  return scope;
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return settings.cloudUrl || process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || "";
}

export async function getPricing() {
  const { scope } = await getScopedDbContext();
  const userPricing = scope.pricing || {};
  const { PROVIDER_PRICING } = await import("@/shared/constants/pricing.js");

  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;

  const { scope } = await getScopedDbContext();
  const userPricing = scope.pricing || {};

  if (provider && userPricing[provider]?.[model]) {
    return userPricing[provider][model];
  }

  const { getPricingForModel: resolve } = await import("@/shared/constants/pricing.js");
  return resolve(provider, model);
}

export async function updatePricing(pricingData) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.pricing) scope.pricing = {};

  for (const [provider, models] of Object.entries(pricingData)) {
    if (!scope.pricing[provider]) scope.pricing[provider] = {};
    for (const [model, pricing] of Object.entries(models)) {
      scope.pricing[provider][model] = pricing;
    }
  }

  await safeWrite(db);
  return scope.pricing;
}

export async function resetPricing(provider, model) {
  const { db, scope } = await getScopedDbContext();
  if (!scope.pricing) scope.pricing = {};

  if (model) {
    if (scope.pricing[provider]) {
      delete scope.pricing[provider][model];
      if (Object.keys(scope.pricing[provider]).length === 0) {
        delete scope.pricing[provider];
      }
    }
  } else {
    delete scope.pricing[provider];
  }

  await safeWrite(db);
  return scope.pricing;
}

export async function resetAllPricing() {
  const { db, scope } = await getScopedDbContext();
  scope.pricing = {};
  await safeWrite(db);
  return scope.pricing;
}
