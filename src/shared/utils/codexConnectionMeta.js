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
  const activeOrganizationNameRaw = normalizeText(providerSpecificData.chatgptActiveOrganizationTitle);
  const activeOrganizationIdRaw = normalizeText(providerSpecificData.chatgptActiveOrganizationId);
  const tokenOrganizationNameRaw = normalizeText(providerSpecificData.chatgptOrganizationTitle);
  const tokenOrganizationIdRaw = normalizeText(providerSpecificData.chatgptOrganizationId);
  const organizationSourceRaw = normalizeText(providerSpecificData.chatgptActiveOrganizationSource);

  const organizationNameRaw = activeOrganizationNameRaw || tokenOrganizationNameRaw;
  const organizationIdRaw = activeOrganizationIdRaw || tokenOrganizationIdRaw;
  const hasOrganizationIdMismatch = !!(
    activeOrganizationIdRaw &&
    tokenOrganizationIdRaw &&
    activeOrganizationIdRaw !== tokenOrganizationIdRaw
  );
  const hasOrganizationNameMismatch = !!(
    !hasOrganizationIdMismatch &&
    activeOrganizationNameRaw &&
    tokenOrganizationNameRaw &&
    activeOrganizationNameRaw !== tokenOrganizationNameRaw
  );
  const isOrganizationMismatch = hasOrganizationIdMismatch || hasOrganizationNameMismatch;

  const organizationDebugTitle = [
    `activeOrganization: ${toDisplayValue(activeOrganizationNameRaw)} (${toDisplayValue(activeOrganizationIdRaw)})`,
    `tokenOrganization: ${toDisplayValue(tokenOrganizationNameRaw)} (${toDisplayValue(tokenOrganizationIdRaw)})`,
    `source: ${toDisplayValue(organizationSourceRaw)}`,
  ].join(" | ");

  return {
    email: toDisplayValue(connection?.email),
    plan: toDisplayValue(providerSpecificData.chatgptPlanType),
    organizationName: toDisplayValue(organizationNameRaw),
    organizationId: toDisplayValue(organizationIdRaw),
    activeOrganizationName: toDisplayValue(activeOrganizationNameRaw),
    activeOrganizationId: toDisplayValue(activeOrganizationIdRaw),
    tokenOrganizationName: toDisplayValue(tokenOrganizationNameRaw),
    tokenOrganizationId: toDisplayValue(tokenOrganizationIdRaw),
    organizationSource: toDisplayValue(organizationSourceRaw),
    organizationDebugTitle,
    isOrganizationMismatch,
  };
}
