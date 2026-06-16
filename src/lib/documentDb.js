import fs from "node:fs";
import { Pool } from "pg";

let pool = null;
const tableReady = new Map();

function cloneDefaultData(defaultData) {
  if (typeof structuredClone === "function") {
    return structuredClone(defaultData);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

export function isPostgresEnabled() {
  return /^postgres(ql)?:\/\//i.test(getDatabaseUrl());
}

function getPool() {
  if (!pool) {
    const connectionString = getDatabaseUrl();
    if (!connectionString) {
      throw new Error("DATABASE_URL is not configured");
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("supabase.com")
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return pool;
}

async function ensureTable(namespace) {
  if (tableReady.has(namespace)) return;
  const currentPool = getPool();
  await currentPool.query(`
    CREATE TABLE IF NOT EXISTS app_documents (
      namespace TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tableReady.set(namespace, true);
}

async function readSeedFile(seedFilePath, defaultData) {
  if (!seedFilePath || !fs.existsSync(seedFilePath)) {
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

export async function createDocumentDb(namespace, defaultData, seedFilePath = "") {
  const defaults = cloneDefaultData(defaultData);

  if (!isPostgresEnabled()) {
    return null;
  }

  await ensureTable(namespace);

  const currentPool = getPool();
  const existing = await currentPool.query(
    "SELECT data FROM app_documents WHERE namespace = $1",
    [namespace]
  );

  if (existing.rowCount === 0) {
    const seedData = await readSeedFile(seedFilePath, defaults);
    await currentPool.query(
      `INSERT INTO app_documents (namespace, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (namespace) DO NOTHING`,
      [namespace, JSON.stringify(seedData)]
    );
    return {
      data: seedData,
      async write() {
        await currentPool.query(
          "UPDATE app_documents SET data = $2::jsonb, updated_at = NOW() WHERE namespace = $1",
          [namespace, JSON.stringify(this.data)]
        );
      },
    };
  }

  const data = existing.rows[0]?.data ?? defaults;
  return {
    data,
    async write() {
      await currentPool.query(
        "UPDATE app_documents SET data = $2::jsonb, updated_at = NOW() WHERE namespace = $1",
        [namespace, JSON.stringify(this.data)]
      );
    },
  };
}
