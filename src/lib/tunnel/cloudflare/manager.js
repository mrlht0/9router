import { getTunnelState, saveTunnelState, generateShortId } from "../shared/state.js";
import { spawnQuickTunnel, killCloudflared, isCloudflaredRunning, setUnexpectedExitHandler } from "./cloudflared.js";
import { clearPid } from "./pid.js";
import { probeUrlAlive, waitForHealth } from "./healthCheck.js";
import { WORKER_URL } from "./config.js";
import { getSettings, updateSettings, runWithUserScope } from "@/lib/localDb";

const getGlobalSettings = () => runWithUserScope(null, async () => await getSettings());
const updateGlobalSettings = (updates) => runWithUserScope(null, async () => await updateSettings(updates));
const getUserSettings = () => getSettings();
const updateUserSettings = (updates) => updateSettings(updates);

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
};

export function getTunnelService() { return svc; }
export function isTunnelManuallyDisabled() { return svc.cancelToken.cancelled; }
export function isTunnelReconnecting() { return svc.spawnInProgress; }

let onUnexpectedExit = null;
export function setTunnelUnexpectedExitCallback(cb) { onUnexpectedExit = cb; }

async function registerTunnelUrl(shortId, tunnelUrl) {
  await fetch(`${WORKER_URL}/api/tunnel/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortId, tunnelUrl })
  });
}

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tunnel cancelled");
}

export async function enableTunnel(localPort = 20128) {
  console.log(`[Tunnel] enable start (port=${localPort})`);
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  const token = svc.cancelToken;

  try {
    if (isCloudflaredRunning()) {
      const existing = await getTunnelState(null);
      if (existing?.tunnelUrl && existing?.shortId) {
        const publicUrl = `https://r${existing.shortId}.abc-tunnel.us`;
        // Reuse only if BOTH direct + public URL alive (avoid stale socket after network change)
        const [directOk, publicOk] = await Promise.all([
          probeUrlAlive(existing.tunnelUrl),
          probeUrlAlive(publicUrl),
        ]);
        if (directOk && publicOk) {
          console.log(`[Tunnel] already running, reuse: ${existing.tunnelUrl}`);
          await saveTunnelState({ shortId: existing.shortId, tunnelUrl: existing.tunnelUrl }, null);
          await updateUserSettings({ tunnelEnabled: true, tunnelUrl: existing.tunnelUrl });
          return { success: true, tunnelUrl: existing.tunnelUrl, shortId: existing.shortId, publicUrl, alreadyRunning: true, attached: true };
        }
        console.log(`[Tunnel] stale (direct=${directOk} public=${publicOk}), respawn`);
      }
    }

    killCloudflared(localPort);
    console.log("[Tunnel] killed existing cloudflared");
    throwIfCancelled(token);

    const existing = await getTunnelState(null);
    const shortId = existing?.shortId || generateShortId();

    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      console.log(`[Tunnel] url updated: ${url}`);
      await registerTunnelUrl(shortId, url);
      await saveTunnelState({ shortId, tunnelUrl: url }, null);
      await updateGlobalSettings({ tunnelEnabled: true, tunnelUrl: url });
      await updateUserSettings({ tunnelEnabled: true, tunnelUrl: url });
    };

    // Register exit handler BEFORE spawn so it fires even on early exit
    setUnexpectedExitHandler(() => {
      console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
      if (onUnexpectedExit) onUnexpectedExit();
    });

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    console.log(`[Tunnel] spawned: ${tunnelUrl}`);
    throwIfCancelled(token);

    const publicUrl = `https://r${shortId}.abc-tunnel.us`;
    await registerTunnelUrl(shortId, tunnelUrl);
    await saveTunnelState({ shortId, tunnelUrl }, null);
    await updateGlobalSettings({ tunnelEnabled: true, tunnelUrl });
    await updateUserSettings({ tunnelEnabled: true, tunnelUrl });
    console.log(`[Tunnel] registered shortId=${shortId} publicUrl=${publicUrl}`);

    // Prefer public short URL, but do not fail the whole enable flow if only the
    // worker-mapped public URL is still propagating while raw trycloudflare works.
    let publicHealthy = false;
    try {
      await waitForHealth(publicUrl, token);
      publicHealthy = true;
      console.log("[Tunnel] public URL healthy");
    } catch (error) {
      console.warn(`[Tunnel] public URL health pending: ${error.message}`);
    }

    const directHealthy = await probeUrlAlive(tunnelUrl);
    if (directHealthy) {
      console.log("[Tunnel] direct URL healthy");
    } else if (publicHealthy) {
      console.warn("[Tunnel] direct URL not reachable yet, continuing via publicUrl");
    } else {
      console.warn("[Tunnel] neither public nor direct URL is healthy yet; returning success with pending health state");
    }

    console.log("[Tunnel] enable success");
    return {
      success: true,
      tunnelUrl,
      shortId,
      publicUrl,
      publicHealthy,
      directHealthy,
      healthPending: !publicHealthy && !directHealthy,
      warning: !publicHealthy && directHealthy
        ? "Public short URL is still propagating. Raw tunnel URL is already available."
        : (!publicHealthy && !directHealthy
          ? "Tunnel process started, but public/direct health checks are still pending."
          : "")
    };
  } catch (e) {
    // Suppress noise when spawn was deliberately killed (restart/disable superseded it)
    if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
      console.error(`[Tunnel] enable error: ${e.message}`);
    }
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTunnel() {
  console.log("[Tunnel] disable");
  // Abort any in-flight enable so it cannot resurrect state after we clear it
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);

  try { killCloudflared(svc.activeLocalPort); } catch (e) { console.warn(`[Tunnel] kill warn: ${e.message}`); }
  clearPid();

  const state = await getTunnelState(null);
  if (state?.shortId) await saveTunnelState({ shortId: state.shortId, tunnelUrl: "" }, null);

  await updateGlobalSettings({ tunnelEnabled: false, tunnelUrl: "" });
  // Force-clear flags so a subsequent enable is not blocked by a stuck spawnInProgress
  svc.spawnInProgress = false;
  svc.activeLocalPort = null;
  return { success: true };
}

export async function getTunnelStatus() {
  const [globalSettings, userSettings, machineState, userState] = await Promise.all([
    getGlobalSettings(),
    getUserSettings(),
    getTunnelState(null),
    getTunnelState(),
  ]);
  const settingsEnabled = userSettings.tunnelEnabled === true;
  const machineEnabled = globalSettings.tunnelEnabled === true;
  const state = machineState;
  const shortId = state?.shortId || "";
  const publicUrl = shortId ? `https://r${shortId}.abc-tunnel.us` : "";
  const tunnelUrl = state?.tunnelUrl || globalSettings.tunnelUrl || userSettings.tunnelUrl || "";
  const running = machineEnabled ? isCloudflaredRunning() : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    userEnabled: settingsEnabled,
    available: running && !!(publicUrl || tunnelUrl),
    machineRunning: running,
    machineEnabled,
    attached: settingsEnabled && running,
    tunnelUrl,
    shortId,
    publicUrl,
    running
  };
}
