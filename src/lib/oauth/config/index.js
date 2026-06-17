function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function getServerCredentials() {
  const server =
    readEnv("OAUTH_SERVER_URL") ||
    readEnv("CLOUD_URL") ||
    readEnv("NEXT_PUBLIC_CLOUD_URL") ||
    readEnv("NEXT_PUBLIC_APP_URL") ||
    readEnv("APP_URL");
  const token =
    readEnv("OAUTH_SERVER_TOKEN") ||
    readEnv("CLOUD_API_KEY") ||
    readEnv("API_KEY");
  const userId =
    readEnv("OAUTH_SERVER_USER_ID") ||
    readEnv("DEFAULT_USER_ID") ||
    "local";

  if (!server) {
    throw new Error("Missing OAUTH_SERVER_URL or CLOUD_URL for OAuth server sync");
  }
  if (!token) {
    throw new Error("Missing OAUTH_SERVER_TOKEN or CLOUD_API_KEY for OAuth server sync");
  }

  return { server: server.replace(/\/+$/, ""), token, userId };
}
