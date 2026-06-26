import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { deleteLocalFileFromDrive, restoreLocalFileFromDrive, scheduleDriveUpload } from "@/lib/driveDb.js";
import { getCurrentUserScopeId, getUserScopeFromContext, getSettings, updateSettings, runWithUserScope } from "@/lib/localDb";

const TUNNEL_DIR = path.join(DATA_DIR, "tunnel");
const LEGACY_STATE_FILE = path.join(TUNNEL_DIR, "state.json");

const SHORT_ID_LENGTH = 6;
const SHORT_ID_CHARS = "abcdefghijklmnpqrstuvwxyz23456789";

function sanitizeOwnerId(ownerId) {
  return String(ownerId || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getStateFile(ownerId = null) {
  return path.join(TUNNEL_DIR, ownerId ? `state.${sanitizeOwnerId(ownerId)}.json` : "state.json");
}

export function ensureTunnelDir() {
  if (!fs.existsSync(TUNNEL_DIR)) fs.mkdirSync(TUNNEL_DIR, { recursive: true });
}

async function resolveOwnerId() {
  const scoped = getUserScopeFromContext();
  if (scoped !== null) return scoped;
  return await getCurrentUserScopeId();
}

async function getScopedSettings(ownerId = undefined) {
  if (ownerId === null) return await runWithUserScope(null, async () => await getSettings());
  return await getSettings();
}

async function updateScopedSettings(ownerId = undefined, updates = {}) {
  if (ownerId === null) return await runWithUserScope(null, async () => await updateSettings(updates));
  return await updateSettings(updates);
}

function readStateSync(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch { /* ignore corrupt state */ }
  return null;
}

function writeStateSync(filePath, state) {
  ensureTunnelDir();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  scheduleDriveUpload(filePath);
}

async function ensureScopedStateFile(ownerId = null) {
  const stateFile = getStateFile(ownerId);
  await restoreLocalFileFromDrive(stateFile).catch(() => false);
  if (ownerId && !fs.existsSync(stateFile)) {
    await restoreLocalFileFromDrive(LEGACY_STATE_FILE).catch(() => false);
    const legacy = readStateSync(LEGACY_STATE_FILE);
    if (legacy) writeStateSync(stateFile, legacy);
  }
  return stateFile;
}

export async function loadState(ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  const stateFile = await ensureScopedStateFile(resolvedOwnerId);
  return readStateSync(stateFile);
}

export function saveState(state, ownerId = null) {
  writeStateSync(getStateFile(ownerId), state);
}

export function clearState(ownerId = null) {
  const stateFile = getStateFile(ownerId);
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    deleteLocalFileFromDrive(stateFile).catch(() => false);
  } catch { /* ignore */ }
}

export async function getTunnelState(ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  const settings = await getScopedSettings(resolvedOwnerId);
  const scopedState = await loadState(resolvedOwnerId);
  const legacy = resolvedOwnerId ? readStateSync(LEGACY_STATE_FILE) : scopedState;

  const shortId = settings.tunnelShortId || settings.tailscaleShortId || scopedState?.shortId || legacy?.shortId || "";
  const tunnelUrl = settings.tunnelUrl || settings.tailscaleUrl || scopedState?.tunnelUrl || legacy?.tunnelUrl || "";
  const state = shortId || tunnelUrl ? { shortId, tunnelUrl } : null;

  if (state && (!scopedState || scopedState.shortId !== state.shortId || scopedState.tunnelUrl !== state.tunnelUrl)) {
    writeStateSync(getStateFile(resolvedOwnerId), state);
  }

  return state;
}

export async function saveTunnelState(state, ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  const next = {
    shortId: state?.shortId || "",
    tunnelUrl: state?.tunnelUrl || "",
  };
  await updateScopedSettings(resolvedOwnerId, {
    tunnelShortId: next.shortId,
    tunnelUrl: next.tunnelUrl,
  });
  writeStateSync(getStateFile(resolvedOwnerId), next);
  return next;
}

export async function clearTunnelState(ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  await updateScopedSettings(resolvedOwnerId, { tunnelShortId: "", tunnelUrl: "" });
  clearState(resolvedOwnerId);
}

export function generateShortId() {
  let result = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    result += SHORT_ID_CHARS.charAt(Math.floor(Math.random() * SHORT_ID_CHARS.length));
  }
  return result;
}

export { TUNNEL_DIR };
