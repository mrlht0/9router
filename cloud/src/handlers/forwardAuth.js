function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a || "");
  const right = new TextEncoder().encode(b || "");
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }

  return diff === 0;
}

export function requireForwardAuth(request, env) {
  const token = env?.FORWARD_AUTH_TOKEN || env?.FORWARD_TOKEN || "";
  if (!token) {
    return new Response(JSON.stringify({ error: "Forwarding is disabled" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = request.headers.get("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const headerToken = request.headers.get("x-9router-forward-token") || "";
  const supplied = bearer || headerToken;

  if (!supplied || !timingSafeEqual(supplied, token)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

export function maskForwardHeaders(headers = {}) {
  const sensitiveKeys = ["authorization", "x-api-key", "api-key", "cookie", "set-cookie", "token", "secret"];
  const masked = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
      masked[key] = value;
      continue;
    }

    const strValue = String(value || "");
    masked[key] = strValue.length > 8
      ? `${strValue.slice(0, 6)}...${strValue.slice(-4)}`
      : "[REDACTED]";
  }

  return masked;
}
