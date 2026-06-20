import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getSettings, updateSettings, runWithUserScope } from "@/lib/localDb";

const TUNNEL_DIR = path.join(DATA_DIR, "tunnel");
const STATE_FILE = path.join(TUNNEL_DIR, "state.json");

const SHORT_ID_LENGTH = 6;
const SHORT_ID_CHARS = "abcdefghijklmnpqrstuvwxyz23456789";

export function ensureTunnelDir() {
  if (!fs.existsSync(TUNNEL_DIR)) fs.mkdirSync(TUNNEL_DIR, { recursive: true });
}

function readLegacyStateSync() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch { /* ignore corrupt state */ }
  return null;
}

function writeLegacyStateSync(state) {
  ensureTunnelDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadState() {
  return readLegacyStateSync();
}

export function saveState(state) {
  writeLegacyStateSync(state);
}

export function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch { /* ignore */ }
}

export async function getTunnelState() {
  const settings = await runWithUserScope(null, async () => await getSettings());
  const legacy = readLegacyStateSync();

  const shortId = settings.tunnelShortId || settings.tailscaleShortId || legacy?.shortId || "";
  const tunnelUrl = settings.tunnelUrl || legacy?.tunnelUrl || "";
  const state = shortId || tunnelUrl ? { shortId, tunnelUrl } : null;

  if (legacy && ((shortId && legacy.shortId !== shortId) || (tunnelUrl && legacy.tunnelUrl !== tunnelUrl))) {
    writeLegacyStateSync(state);
  }

  return state;
}

export async function saveTunnelState(state) {
  const next = {
    shortId: state?.shortId || "",
    tunnelUrl: state?.tunnelUrl || "",
  };
  await runWithUserScope(null, async () => await updateSettings({
    tunnelShortId: next.shortId,
    tunnelUrl: next.tunnelUrl,
  }));
  writeLegacyStateSync(next);
  return next;
}

export async function clearTunnelState() {
  await runWithUserScope(null, async () => await updateSettings({ tunnelShortId: "", tunnelUrl: "" }));
  clearState();
}

export function generateShortId() {
  let result = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    result += SHORT_ID_CHARS.charAt(Math.floor(Math.random() * SHORT_ID_CHARS.length));
  }
  return result;
}

export { TUNNEL_DIR };
