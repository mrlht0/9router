import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";
import { createDocumentDb, isMongoEnabled, isPostgresEnabled } from "@/lib/documentDb.js";
import * as sqliteDb from "@/lib/db/index.js";

const DB_FILE = path.join(DATA_DIR, "disabledModels.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultData = { disabled: {} };

let dbInstance = null;

async function getDb() {
  if (isPostgresEnabled() || isMongoEnabled()) {
    const pgDb = await createDocumentDb("disabledModelsDb", defaultData, DB_FILE, {
      preferredBackends: ["postgres", "mongo"],
      syncBackends: true,
      seedFromFile: false,
    });
    if (!pgDb.data || typeof pgDb.data !== "object") pgDb.data = { ...defaultData };
    if (!pgDb.data.disabled) pgDb.data.disabled = {};
    return pgDb;
  }

  if (!dbInstance) {
    let fileData = { ...defaultData };
    try {
      if (fs.existsSync(DB_FILE)) {
        const fileContent = fs.readFileSync(DB_FILE, "utf8");
        fileData = JSON.parse(fileContent);
      }
    } catch (error) {
      // syntax errors or read errors
    }
    if (!fileData || typeof fileData !== "object") fileData = { ...defaultData };
    if (!fileData.disabled) fileData.disabled = {};

    dbInstance = {
      data: fileData,
      async read() {
        try {
          if (fs.existsSync(DB_FILE)) {
            const fileContent = fs.readFileSync(DB_FILE, "utf8");
            this.data = JSON.parse(fileContent);
          }
        } catch (error) {
          // ignore
        }
      },
      async write() {
        fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), "utf8");
      }
    };
  }
  return dbInstance;
}

export async function getDisabledModels() {
  if (!isPostgresEnabled() && !isMongoEnabled()) {
    return await sqliteDb.getDisabledModels();
  }
  const db = await getDb();
  return db.data.disabled || {};
}

export async function getDisabledByProvider(providerAlias) {
  if (!isPostgresEnabled() && !isMongoEnabled()) {
    return await sqliteDb.getDisabledByProvider(providerAlias);
  }
  const all = await getDisabledModels();
  return all[providerAlias] || [];
}

export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  if (!isPostgresEnabled() && !isMongoEnabled()) {
    return await sqliteDb.disableModels(providerAlias, ids);
  }
  const db = await getDb();
  const current = new Set(db.data.disabled[providerAlias] || []);
  ids.forEach((id) => current.add(id));
  db.data.disabled[providerAlias] = [...current];
  await db.write();
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  if (!isPostgresEnabled() && !isMongoEnabled()) {
    return await sqliteDb.enableModels(providerAlias, ids);
  }
  const db = await getDb();
  const current = db.data.disabled[providerAlias] || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    delete db.data.disabled[providerAlias];
  } else {
    const removeSet = new Set(ids);
    const next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) delete db.data.disabled[providerAlias];
    else db.data.disabled[providerAlias] = next;
  }
  await db.write();
}
