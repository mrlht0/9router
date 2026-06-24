import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://google-drive-db.onrender.com";
const DEFAULT_ACCOUNT = "tljapan8";
const DRIVE_SYNC_DEBOUNCE_MS = Number(process.env.DRIVE_SYNC_DEBOUNCE_MS || 15000);

if (!global._driveSyncState) {
  global._driveSyncState = {
    restorePromises: new Map(),
    uploadTimers: new Map(),
  };
}

const state = global._driveSyncState;

function getDriveConfig() {
  const baseUrl = String(process.env.DRIVE_DB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const account = String(process.env.DRIVE_DB_ACCOUNT || DEFAULT_ACCOUNT).trim();
  const folderId = String(process.env.DRIVE_DB_FOLDER_ID || "").trim();
  const apiToken = String(process.env.DRIVE_DB_API_TOKEN || "").trim();
  const enabled = !!baseUrl && !!account && !!folderId && !!apiToken;
  return { baseUrl, account, folderId, apiToken, enabled };
}

function buildDriveUrl(config, pathname, query = {}) {
  const params = new URLSearchParams({
    account: config.account,
    apiToken: config.apiToken,
  });
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return `${config.baseUrl}${pathname}?${params.toString()}`;
}

function collectItems(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectItems(item, out);
    return out;
  }
  if (typeof value !== "object") return out;

  const name = typeof value.name === "string" ? value.name : typeof value.title === "string" ? value.title : "";
  const id = typeof value.id === "string" ? value.id : typeof value.fileId === "string" ? value.fileId : "";
  if (name && id) out.push({ id, name, raw: value });

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") collectItems(nested, out);
  }
  return out;
}

async function findRemoteFileId(fileName) {
  const config = getDriveConfig();
  if (!config.enabled) return null;
  const url = buildDriveUrl(config, "/api/oauth/drive/tree", { parentId: config.folderId });
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Drive tree request failed: ${res.status}`);
  const payload = await res.json().catch(() => null);
  const items = collectItems(payload);
  const match = items.find((item) => item.name === fileName);
  return match?.id || null;
}

export async function restoreLocalFileFromDrive(localPath) {
  const config = getDriveConfig();
  if (!config.enabled) return false;
  const fileName = path.basename(localPath);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) return false;

  const cacheKey = `${config.account}:${fileName}`;
  if (!state.restorePromises.has(cacheKey)) {
    state.restorePromises.set(cacheKey, (async () => {
      const fileId = await findRemoteFileId(fileName);
      if (!fileId) return false;
      const url = buildDriveUrl(config, `/api/oauth/drive/stream/${encodeURIComponent(fileId)}`);
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Drive stream request failed: ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, Buffer.from(arrayBuffer));
      console.log(`[DriveSync] restored ${fileName} from Drive`);
      return true;
    })().finally(() => {
      state.restorePromises.delete(cacheKey);
    }));
  }
  return await state.restorePromises.get(cacheKey);
}

export function scheduleDriveUpload(localPath) {
  const config = getDriveConfig();
  if (!config.enabled) return;
  const fileName = path.basename(localPath);
  const cacheKey = `${config.account}:${fileName}`;
  if (state.uploadTimers.has(cacheKey)) clearTimeout(state.uploadTimers.get(cacheKey));
  state.uploadTimers.set(cacheKey, setTimeout(() => {
    uploadLocalFileToDrive(localPath).catch((error) => {
      console.warn(`[DriveSync] upload failed for ${fileName}: ${error.message}`);
    }).finally(() => {
      state.uploadTimers.delete(cacheKey);
    });
  }, DRIVE_SYNC_DEBOUNCE_MS));
}

export async function uploadLocalFileToDrive(localPath) {
  const config = getDriveConfig();
  if (!config.enabled) return false;
  if (!fs.existsSync(localPath)) return false;
  const fileName = path.basename(localPath);
  const form = new FormData();
  form.append("parentId", config.folderId);
  form.append("overwrite", "true");
  form.append("file", new Blob([fs.readFileSync(localPath)]), fileName);
  const res = await fetch(buildDriveUrl(config, "/api/oauth/drive/upload"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status}`);
  console.log(`[DriveSync] uploaded ${fileName} to Drive`);
  return true;
}

export async function deleteLocalFileFromDrive(localPath) {
  const config = getDriveConfig();
  if (!config.enabled) return false;
  const fileName = path.basename(localPath);
  const fileId = await findRemoteFileId(fileName);
  if (!fileId) return false;
  await deleteDriveItem(fileId);
  console.log(`[DriveSync] deleted ${fileName} from Drive`);
  return true;
}

export function isDriveSyncEnabled() {
  return getDriveConfig().enabled;
}

export async function loadJsonDocumentFromDrive(fileName, defaultValue = null) {
  const config = getDriveConfig();
  if (!config.enabled) return defaultValue;
  const fileId = await findRemoteFileId(fileName);
  if (!fileId) return defaultValue;
  const url = buildDriveUrl(config, `/api/oauth/drive/stream/${encodeURIComponent(fileId)}`);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Drive stream request failed: ${res.status}`);
  const textPayload = Buffer.from(await res.arrayBuffer()).toString("utf8");
  return JSON.parse(textPayload || "null") ?? defaultValue;
}

export async function writeJsonDocumentToDrive(fileName, value) {
  const config = getDriveConfig();
  if (!config.enabled) return false;
  const form = new FormData();
  form.append("parentId", config.folderId);
  form.append("overwrite", "true");
  form.append("file", new Blob([JSON.stringify(value)]), fileName);
  const res = await fetch(buildDriveUrl(config, "/api/oauth/drive/upload"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status}`);
  console.log(`[DriveSync] uploaded ${fileName} to Drive`);
  return true;
}

export async function getDriveTree(parentId = "") {
  const config = getDriveConfig();
  if (!config.enabled) return null;
  const targetParentId = String(parentId || config.folderId).trim();
  const res = await fetch(buildDriveUrl(config, "/api/oauth/drive/tree", { parentId: targetParentId }), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Drive tree request failed: ${res.status}`);
  return await res.json();
}

export function getDriveStreamUrl(fileId) {
  const config = getDriveConfig();
  if (!config.enabled || !fileId) return "";
  return buildDriveUrl(config, `/api/oauth/drive/stream/${encodeURIComponent(fileId)}`);
}

export function getDriveProxyUrl(fileId) {
  const config = getDriveConfig();
  if (!config.enabled || !fileId) return "";
  return buildDriveUrl(config, `/api/oauth/drive/proxy/${encodeURIComponent(fileId)}`);
}

export function getDrivePreviewLinkUrl(fileId) {
  const config = getDriveConfig();
  if (!config.enabled || !fileId) return "";
  return buildDriveUrl(config, `/api/oauth/drive/preview-link/${encodeURIComponent(fileId)}`);
}

export async function getDriveStorage() {
  const config = getDriveConfig();
  if (!config.enabled) return null;
  const res = await fetch(buildDriveUrl(config, "/api/storage", { source: "oauth" }), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Drive storage request failed: ${res.status}`);
  return await res.json();
}

export async function createDriveFolder(name, parentId = "") {
  const config = getDriveConfig();
  if (!config.enabled) return null;
  const res = await fetch(buildDriveUrl(config, "/api/oauth/drive/folder"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parentId: String(parentId || config.folderId).trim(),
    }),
  });
  if (!res.ok) throw new Error(`Drive folder create failed: ${res.status}`);
  return await res.json();
}

export async function deleteDriveItem(itemId) {
  const config = getDriveConfig();
  if (!config.enabled || !itemId) return false;
  const res = await fetch(buildDriveUrl(config, `/api/oauth/drive/item/${encodeURIComponent(itemId)}`), {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Drive delete failed: ${res.status}`);
  return true;
}
