import { getTunnelState, generateShortId } from "../shared/state.js";
import { startFunnel, stopFunnel, isTailscaleRunning, isTailscaleRunningStrict, isTailscaleLoggedIn, isTailscaleLoggedInStrict, startLogin, startDaemonWithPassword, provisionCert } from "./tailscale.js";
import { waitForHealth } from "./healthCheck.js";
import { getSettings, updateSettings, runWithUserScope } from "@/lib/localDb";
import { getCachedPassword, loadEncryptedPassword, initDbHooks } from "@/mitm/manager";

const getGlobalSettings = () => runWithUserScope(null, async () => await getSettings());
const updateGlobalSettings = (updates) => runWithUserScope(null, async () => await updateSettings(updates));
const getUserSettings = () => getSettings();
const updateUserSettings = (updates) => updateSettings(updates);

initDbHooks(getGlobalSettings, updateGlobalSettings);

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
};

export function getTailscaleService() { return svc; }
export function isTailscaleReconnecting() { return svc.spawnInProgress; }

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tailscale cancelled");
}

export async function enableTailscale(localPort = 20128) {
  console.log(`[Tailscale] enable start (port=${localPort})`);
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  const token = svc.cancelToken;

  try {
    const sudoPass = getCachedPassword() || await loadEncryptedPassword() || "";
    await startDaemonWithPassword(sudoPass);
    console.log("[Tailscale] daemon ready");
    throwIfCancelled(token);

    const existing = await getTunnelState(null);
    const shortId = existing?.shortId || generateShortId();
    const tsHostname = shortId;

    const runningNow = await isTailscaleRunningStrict().catch(() => false);
    if (runningNow) {
      const machineUrl = (await getGlobalSettings()).tailscaleUrl || "";
      if (machineUrl) {
        await updateUserSettings({ tailscaleEnabled: true, tailscaleUrl: machineUrl });
        return { success: true, tunnelUrl: machineUrl, alreadyRunning: true, attached: true };
      }
    }
    const loggedIn = await isTailscaleLoggedInStrict();
    console.log(`[Tailscale] loggedIn=${loggedIn}`);
    if (!loggedIn) {
      const loginResult = await startLogin(tsHostname);
      if (loginResult.authUrl) {
        console.log(`[Tailscale] needs login, authUrl=${loginResult.authUrl}`);
        return { success: false, needsLogin: true, authUrl: loginResult.authUrl };
      }
      console.log("[Tailscale] login resolved alreadyLoggedIn");
    }
    throwIfCancelled(token);

    stopFunnel();
    let result;
    try {
      console.log("[Tailscale] starting funnel");
      result = await startFunnel(localPort);
    } catch (e) {
      console.error(`[Tailscale] funnel error: ${e.message}`);
      // Daemon not logged in / not ready → auto-trigger login flow so user stays in-app
      if (/NoState|unexpected state|not logged in|Logged ?out|NeedsLogin/i.test(e.message || "")) {
        console.log("[Tailscale] retry via startLogin");
        const loginResult = await startLogin(tsHostname);
        if (loginResult.authUrl) return { success: false, needsLogin: true, authUrl: loginResult.authUrl };
      }
      throw e;
    }
    throwIfCancelled(token);

    if (result.funnelNotEnabled) {
      console.log(`[Tailscale] funnel not enabled, enableUrl=${result.enableUrl}`);
      return { success: false, funnelNotEnabled: true, enableUrl: result.enableUrl };
    }

    // Strict probe: bypass cache so we don't false-negative on first invocation
    if (!(await isTailscaleLoggedInStrict()) || !(await isTailscaleRunningStrict())) {
      console.error("[Tailscale] strict probe failed (device removed?)");
      stopFunnel();
      return { success: false, error: "Tailscale not connected. Device may have been removed. Please re-login." };
    }

    await updateGlobalSettings({ tailscaleEnabled: true, tailscaleUrl: result.tunnelUrl });
    await updateUserSettings({ tailscaleEnabled: true, tailscaleUrl: result.tunnelUrl });
    console.log(`[Tailscale] funnel up: ${result.tunnelUrl}`);

    // Provision TLS cert so Funnel can serve HTTPS (non-fatal if fails)
    const hostname = new URL(result.tunnelUrl).hostname;
    await provisionCert(hostname);

    // Verify funnel serves /api/health — timeout is non-fatal (DNS may still be propagating)
    let reachableNow = false;
    try {
      await waitForHealth(result.tunnelUrl, token);
      reachableNow = true;
    } catch (he) {
      if (!he.message.startsWith("Health check timeout")) throw he;
      console.warn(`[Tailscale] health check timed out, will retry via watchdog`);
    }
    console.log(`[Tailscale] enable success (reachable=${reachableNow})`);
    return { success: true, tunnelUrl: result.tunnelUrl };
  } catch (e) {
    console.error(`[Tailscale] enable error: ${e.message}`);
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTailscale() {
  console.log("[Tailscale] disable");
  svc.cancelToken.cancelled = true;
  stopFunnel();
  await updateGlobalSettings({ tailscaleEnabled: false, tailscaleUrl: "" });
  return { success: true };
}

export async function getTailscaleStatus() {
  const [globalSettings, userSettings] = await Promise.all([getGlobalSettings(), getUserSettings()]);
  const settingsEnabled = userSettings.tailscaleEnabled === true;
  const machineEnabled = globalSettings.tailscaleEnabled === true;
  const tunnelUrl = globalSettings.tailscaleUrl || userSettings.tailscaleUrl || "";
  const loggedIn = machineEnabled ? isTailscaleLoggedIn() : false;
  const running = loggedIn ? isTailscaleRunning() : false;
  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    userEnabled: settingsEnabled,
    available: running && !!tunnelUrl,
    machineRunning: running,
    machineEnabled,
    attached: settingsEnabled && running,
    tunnelUrl,
    running,
    loggedIn
  };
}
