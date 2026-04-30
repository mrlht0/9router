const FALLBACK_VALUE = "-";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toDisplayValue(value) {
  return normalizeText(value) || FALLBACK_VALUE;
}

export function isCodexOAuthConnection(connection) {
  return connection?.provider === "codex" && connection?.authType === "oauth";
}

export function getCodexConnectionMeta(connection) {
  const providerSpecificData = connection?.providerSpecificData || {};
  const organizationNameRaw = normalizeText(
    providerSpecificData.organizationName ||
    providerSpecificData.chatgptOrganizationName ||
    providerSpecificData.chatgptOrganizationTitle ||
    providerSpecificData.chatgptActiveOrganizationTitle,
  );
  const debugTitle = `organizationName: ${toDisplayValue(organizationNameRaw)}`;

  return {
    email: toDisplayValue(connection?.email),
    plan: toDisplayValue(providerSpecificData.chatgptPlanType),
    organizationName: toDisplayValue(organizationNameRaw),
    debugTitle,
  };
}
