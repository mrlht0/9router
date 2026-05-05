import { createProviderConnection, getProviderConnections } from "@/models";

export const dynamic = "force-dynamic";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseExpiresIn(value) {
  if (value === undefined || value === null || value === "") return null;

  const expiresIn = Number(value);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null;
}

function sanitizeOptionalString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function buildProviderSpecificData(existingProviderSpecificData = {}, projectId) {
  const existingAntigravity = { ...(existingProviderSpecificData.antigravity || {}) };
  for (const key of [
    "cooldownUntil",
    "cooldownReason",
    "rateLimitResetTimes",
    "model",
    "lastProviderStatus",
    "retryAfterMs",
    "reauthRequired",
    "reauthReason",
    "reauthRequiredAt",
  ]) {
    delete existingAntigravity[key];
  }

  return {
    ...existingProviderSpecificData,
    antigravity: {
      ...existingAntigravity,
      enabled: true,
      projectId: projectId || null,
      reauthRequired: false,
      reauthReason: null,
      reauthRequiredAt: null,
      lastUsedAt: null,
    },
  };
}

async function getExistingProviderSpecificData(email) {
  if (!email) return {};

  const connections = await getProviderConnections({ provider: "antigravity" });
  const existingConnection = connections.find(
    (connection) => connection.authType === "oauth" && connection.email === email
  );
  return existingConnection?.providerSpecificData || {};
}

function safeConnection(connection) {
  const result = { ...connection };
  delete result.accessToken;
  delete result.refreshToken;
  delete result.apiKey;
  delete result.idToken;
  return result;
}

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid or empty request body" }, { status: 400 });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const accessToken = sanitizeOptionalString(body.accessToken);
    const refreshToken = sanitizeOptionalString(body.refreshToken);
    const email = sanitizeOptionalString(body.email);
    const scope = sanitizeOptionalString(body.scope);
    const projectId = sanitizeOptionalString(body.projectId);
    const expiresIn = parseExpiresIn(body.expiresIn);

    if (!accessToken) {
      return Response.json({ error: "Access token is required" }, { status: 400 });
    }

    if (!refreshToken) {
      return Response.json({ error: "Refresh token is required" }, { status: 400 });
    }

    const existingProviderSpecificData = await getExistingProviderSpecificData(email);

    const connection = await createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name: email || "Antigravity Account",
      email,
      accessToken,
      refreshToken,
      expiresIn,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope,
      projectId,
      isActive: true,
      testStatus: "active",
      errorCode: null,
      lastError: null,
      lastErrorAt: null,
      providerSpecificData: buildProviderSpecificData(existingProviderSpecificData, projectId),
    });

    return Response.json({
      success: true,
      connection: safeConnection(connection),
    }, { status: 201 });
  } catch (error) {
    console.error("Antigravity CLI provider save error:", error);
    return Response.json({ error: error.message || "Failed to save Antigravity provider" }, { status: 500 });
  }
}
