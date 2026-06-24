import fs from "fs";
import path from "path";
import os from "os";
import { restoreLocalFileFromDrive, scheduleDriveUpload } from "@/lib/driveDb.js";
import { getCurrentUserScopeId, getUserScopeFromContext, runWithUserScope } from "@/lib/localDb.js";

const DATA_DIR = process.env.DATA_DIR
  || (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router"));

const MITM_DIR = path.join(DATA_DIR, "mitm");
const LEGACY_CACHE_FILE = path.join(MITM_DIR, "aliases.json");

function sanitizeOwnerId(ownerId) {
  return String(ownerId || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getCacheFile(ownerId = null) {
  return path.join(MITM_DIR, ownerId ? `aliases.${sanitizeOwnerId(ownerId)}.json` : "aliases.json");
}

async function resolveOwnerId() {
  const scoped = getUserScopeFromContext();
  if (scoped !== null) return scoped;
  return await getCurrentUserScopeId();
}

function writeAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
  scheduleDriveUpload(filePath);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function ensureCacheFile(ownerId = null) {
  const cacheFile = getCacheFile(ownerId);
  await restoreLocalFileFromDrive(cacheFile).catch(() => false);
  if (ownerId && !fs.existsSync(cacheFile)) {
    await restoreLocalFileFromDrive(LEGACY_CACHE_FILE).catch(() => false);
    if (fs.existsSync(LEGACY_CACHE_FILE)) {
      writeAtomic(cacheFile, readJsonFile(LEGACY_CACHE_FILE));
    }
  }
  return cacheFile;
}

export async function syncToJson(ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  const cacheFile = await ensureCacheFile(resolvedOwnerId);
  try {
    const all = await runWithUserScope(resolvedOwnerId, async () => {
      const { getMitmAlias } = await import("@/models");
      return await getMitmAlias();
    });
    writeAtomic(cacheFile, all || {});
  } catch (error) {
    console.log("[mitmAliasCache] sync failed:", error.message);
  }
}

export async function writeAliasForTool(tool, mappings, ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  const cacheFile = await ensureCacheFile(resolvedOwnerId);
  try {
    const current = readJsonFile(cacheFile);
    current[tool] = mappings || {};
    writeAtomic(cacheFile, current);
  } catch (error) {
    console.log("[mitmAliasCache] write failed:", error.message);
  }
}
