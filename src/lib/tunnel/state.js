import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { deleteLocalFileFromDrive, restoreLocalFileFromDrive, scheduleDriveUpload } from "@/lib/driveDb.js";
import { getCurrentUserScopeId, getUserScopeFromContext } from "@/lib/localDb.js";

const TUNNEL_DIR = path.join(DATA_DIR, "tunnel");
const LEGACY_STATE_FILE = path.join(TUNNEL_DIR, "state.json");
const CLOUDFLARED_PID_FILE = path.join(TUNNEL_DIR, "cloudflared.pid");
const TAILSCALE_PID_FILE = path.join(TUNNEL_DIR, "tailscale.pid");

function sanitizeOwnerId(ownerId) {
  return String(ownerId || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getStateFile(ownerId = null) {
  return path.join(TUNNEL_DIR, ownerId ? `state.${sanitizeOwnerId(ownerId)}.json` : "state.json");
}

function ensureDir() {
  if (!fs.existsSync(TUNNEL_DIR)) {
    fs.mkdirSync(TUNNEL_DIR, { recursive: true });
  }
}

async function resolveOwnerId() {
  const scoped = getUserScopeFromContext();
  if (scoped !== null) return scoped;
  return await getCurrentUserScopeId();
}

function readStateSync(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) { /* ignore corrupt state */ }
  return null;
}

async function ensureScopedStateFile(ownerId = null) {
  const stateFile = getStateFile(ownerId);
  await restoreLocalFileFromDrive(stateFile).catch(() => false);
  if (ownerId && !fs.existsSync(stateFile)) {
    await restoreLocalFileFromDrive(LEGACY_STATE_FILE).catch(() => false);
    const legacy = readStateSync(LEGACY_STATE_FILE);
    if (legacy) saveState(legacy, ownerId);
  }
  return stateFile;
}

export async function loadState(ownerId = undefined) {
  const resolvedOwnerId = ownerId === undefined ? await resolveOwnerId() : ownerId;
  try {
    const stateFile = await ensureScopedStateFile(resolvedOwnerId);
    return readStateSync(stateFile);
  } catch (e) { /* ignore corrupt state */ }
  return null;
}

export function saveState(state, ownerId = null) {
  ensureDir();
  const stateFile = getStateFile(ownerId);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  scheduleDriveUpload(stateFile);
}

export function clearState(ownerId = null) {
  const stateFile = getStateFile(ownerId);
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    deleteLocalFileFromDrive(stateFile).catch(() => false);
  } catch (e) { /* ignore */ }
}

// Cloudflare-specific PID
export function savePid(pid) {
  ensureDir();
  fs.writeFileSync(CLOUDFLARED_PID_FILE, pid.toString());
}

export function loadPid() {
  try {
    if (fs.existsSync(CLOUDFLARED_PID_FILE)) {
      return parseInt(fs.readFileSync(CLOUDFLARED_PID_FILE, "utf8"));
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function clearPid() {
  try {
    if (fs.existsSync(CLOUDFLARED_PID_FILE)) fs.unlinkSync(CLOUDFLARED_PID_FILE);
  } catch (e) { /* ignore */ }
}

// Tailscale-specific PID
export function saveTailscalePid(pid) {
  ensureDir();
  fs.writeFileSync(TAILSCALE_PID_FILE, pid.toString());
}

export function loadTailscalePid() {
  try {
    if (fs.existsSync(TAILSCALE_PID_FILE)) {
      return parseInt(fs.readFileSync(TAILSCALE_PID_FILE, "utf8"));
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function clearTailscalePid() {
  try {
    if (fs.existsSync(TAILSCALE_PID_FILE)) fs.unlinkSync(TAILSCALE_PID_FILE);
  } catch (e) { /* ignore */ }
}

const SHORT_ID_LENGTH = 6;
const SHORT_ID_CHARS = "abcdefghijklmnpqrstuvwxyz23456789";

export function generateShortId() {
  let result = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    result += SHORT_ID_CHARS.charAt(Math.floor(Math.random() * SHORT_ID_CHARS.length));
  }
  return result;
}
