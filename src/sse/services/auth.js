import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, getEarliestModelLockUntil, getModelLockKey } from "open-sse/services/accountFallback.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

function isReauthRequiredConnection(connection) {
  return connection?.provider === "antigravity" && (
    connection.testStatus === "reauth_required" ||
    connection.errorCode === "reauth_required" ||
    connection.providerSpecificData?.antigravity?.reauthRequired === true
  );
}

function normalizeErrorMetadata(statusOrMetadata, maybeResetsAtMs) {
  const metadata = statusOrMetadata && typeof statusOrMetadata === "object" && !Array.isArray(statusOrMetadata)
    ? statusOrMetadata
    : { status: statusOrMetadata };
  const resetsAtMs = metadata.resetsAtMs ?? maybeResetsAtMs ?? null;
  return {
    status: metadata.status ?? metadata.statusCode ?? null,
    reason: metadata.reason ?? null,
    retryAfterMs: metadata.retryAfterMs ?? null,
    resetsAtMs,
  };
}

function buildAntigravityCooldownData(conn, model, lockUntilIso, metadata, nowIso) {
  const providerSpecificData = { ...(conn?.providerSpecificData || {}) };
  const current = providerSpecificData.antigravity || {};
  const rateLimitResetTimes = { ...(current.rateLimitResetTimes || {}) };
  const modelKey = model || "__all";
  rateLimitResetTimes[modelKey] = lockUntilIso;

  providerSpecificData.antigravity = {
    ...current,
    cooldownUntil: lockUntilIso,
    cooldownReason: metadata.reason || current.cooldownReason || "rate_limit_unknown",
    rateLimitResetTimes,
    model: model || null,
    lastProviderStatus: metadata.status ?? current.lastProviderStatus ?? null,
    retryAfterMs: metadata.retryAfterMs ?? current.retryAfterMs ?? null,
    lastUsedAt: nowIso,
  };

  return providerSpecificData;
}

function buildAntigravitySelectionData(conn, nowIso) {
  const providerSpecificData = { ...(conn?.providerSpecificData || {}) };
  providerSpecificData.antigravity = {
    ...(providerSpecificData.antigravity || {}),
    lastUsedAt: nowIso,
  };
  return providerSpecificData;
}

function hasAntigravityCooldownMetadata(conn) {
  const current = conn?.providerSpecificData?.antigravity;
  if (!current) return false;
  return Boolean(
    current.cooldownUntil ||
    current.cooldownReason ||
    current.rateLimitResetTimes ||
    Object.prototype.hasOwnProperty.call(current, "model") ||
    Object.prototype.hasOwnProperty.call(current, "lastProviderStatus") ||
    Object.prototype.hasOwnProperty.call(current, "retryAfterMs")
  );
}

function pruneAntigravityCooldownData(conn, keysToClear, now) {
  const providerSpecificData = conn?.providerSpecificData;
  const current = providerSpecificData?.antigravity;
  if (!current) return null;

  const keysToClearSet = new Set(keysToClear);
  const rateLimitResetTimes = { ...(current.rateLimitResetTimes || {}) };
  for (const key of keysToClear) {
    if (!key.startsWith("modelLock_")) continue;
    const modelKey = key === "modelLock___all" ? "__all" : key.slice("modelLock_".length);
    delete rateLimitResetTimes[modelKey];
  }

  const activeFlatResetTimes = {};
  for (const [key, expiry] of Object.entries(conn || {})) {
    if (!key.startsWith("modelLock_") || keysToClearSet.has(key)) continue;
    const expiryMs = expiry ? new Date(expiry).getTime() : NaN;
    if (!Number.isFinite(expiryMs) || expiryMs <= now) continue;
    const modelKey = key === "modelLock___all" ? "__all" : key.slice("modelLock_".length);
    activeFlatResetTimes[modelKey] = expiry;
  }

  for (const modelKey of Object.keys(rateLimitResetTimes)) {
    if (activeFlatResetTimes[modelKey]) {
      rateLimitResetTimes[modelKey] = activeFlatResetTimes[modelKey];
    } else {
      delete rateLimitResetTimes[modelKey];
    }
  }

  for (const [modelKey, expiry] of Object.entries(activeFlatResetTimes)) {
    rateLimitResetTimes[modelKey] = expiry;
  }

  const antigravity = { ...current };
  if (Object.keys(rateLimitResetTimes).length > 0) {
    antigravity.rateLimitResetTimes = rateLimitResetTimes;
    const [activeModelKey, activeUntil] = Object.entries(rateLimitResetTimes)
      .map(([modelKey, expiry]) => [modelKey, new Date(expiry).getTime()])
      .filter(([, expiry]) => expiry > now)
      .sort((a, b) => a[1] - b[1])[0] || [];
    if (activeUntil) {
      antigravity.cooldownUntil = new Date(activeUntil).toISOString();
      antigravity.model = activeModelKey === "__all" ? null : activeModelKey;
    }
  } else {
    delete antigravity.rateLimitResetTimes;
    delete antigravity.cooldownUntil;
    delete antigravity.cooldownReason;
    delete antigravity.model;
    delete antigravity.lastProviderStatus;
    delete antigravity.retryAfterMs;
  }

  const nextProviderSpecificData = { ...providerSpecificData };
  if (Object.keys(antigravity).length > 0) {
    nextProviderSpecificData.antigravity = antigravity;
  } else {
    delete nextProviderSpecificData.antigravity;
  }

  return nextProviderSpecificData;
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isReauthRequiredConnection(c)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const reauthRequired = isReauthRequiredConnection(c);
      const locked = isModelLockActive(c, model);
      if (excluded || reauthRequired || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${reauthRequired ? "reauth_required" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      const selectableConnections = connections.filter(c => !excludeSet.has(c.id) && !isReauthRequiredConnection(c));
      if (selectableConnections.length === 0 && connections.some(isReauthRequiredConnection)) {
        log.warn("AUTH", `${provider} | all remaining accounts require reconnect`);
        return null;
      }
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = selectableConnections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    let selectionPersisted = false;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      const nowIso = new Date().toISOString();
      const selectionUpdate = {
        lastUsedAt: nowIso,
      };
      if (connection.provider === "antigravity") {
        selectionUpdate.providerSpecificData = buildAntigravitySelectionData(connection, nowIso);
      }
      await updateProviderConnection(connection.id, selectionUpdate);
      connection = { ...connection, ...selectionUpdate };
      selectionPersisted = true;
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        const nowIso = new Date().toISOString();
        const selectionUpdate = {
          lastUsedAt: nowIso,
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        };
        if (connection.provider === "antigravity") {
          selectionUpdate.providerSpecificData = buildAntigravitySelectionData(connection, nowIso);
        }
        await updateProviderConnection(connection.id, selectionUpdate);
        connection = { ...connection, ...selectionUpdate };
        selectionPersisted = true;
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        const nowIso = new Date().toISOString();
        const selectionUpdate = {
          lastUsedAt: nowIso,
          consecutiveUseCount: 1
        };
        if (connection.provider === "antigravity") {
          selectionUpdate.providerSpecificData = buildAntigravitySelectionData(connection, nowIso);
        }
        await updateProviderConnection(connection.id, selectionUpdate);
        connection = { ...connection, ...selectionUpdate };
        selectionPersisted = true;
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    if (!selectionPersisted) {
      const nowIso = new Date().toISOString();
      const selectionUpdate = { lastUsedAt: nowIso };
      if (connection.provider === "antigravity") {
        selectionUpdate.providerSpecificData = buildAntigravitySelectionData(connection, nowIso);
      }
      await updateProviderConnection(connection.id, selectionUpdate);
      connection = { ...connection, ...selectionUpdate };
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number|object} status - HTTP status code or upstream error metadata
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const metadata = normalizeErrorMetadata(status, resetsAtMs);
  const providerId = resolveProviderId(provider);
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;
  const now = Date.now();

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (metadata.resetsAtMs && metadata.resetsAtMs > now) {
    shouldFallback = true;
    cooldownMs = metadata.resetsAtMs - now;
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(metadata.status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUntilIso = metadata.resetsAtMs && metadata.resetsAtMs > now
    ? new Date(metadata.resetsAtMs).toISOString()
    : new Date(now + cooldownMs).toISOString();
  const lockUpdate = { [getModelLockKey(model)]: lockUntilIso };
  const update = {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: metadata.status,
    lastErrorAt: new Date(now).toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  };

  if (providerId === "antigravity" && conn) {
    update.providerSpecificData = buildAntigravityCooldownData(
      conn,
      model,
      lockUntilIso,
      metadata,
      new Date(now).toISOString()
    );
  }

  await updateProviderConnection(connectionId, update);

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${metadata.status}]`);

  if (provider && metadata.status && reason) {
    console.error(`❌ ${provider} [${metadata.status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  if (isReauthRequiredConnection(conn)) return;
  const providerId = resolveProviderId(conn?.provider || currentConnection?.provider);
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));
  const shouldPruneAntigravity = providerId === "antigravity" && hasAntigravityCooldownMetadata(conn);

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0 && !shouldPruneAntigravity) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError && !shouldPruneAntigravity) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));
  if (providerId === "antigravity") {
    const nextProviderSpecificData = pruneAntigravityCooldownData(conn, keysToClear, now);
    if (nextProviderSpecificData !== null) clearObj.providerSpecificData = nextProviderSpecificData;
  }

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
