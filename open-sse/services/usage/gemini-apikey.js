/**
 * Gemini API Key Usage Handler
 */

import { buildGeminiApiKeyQuotaUsage } from "@/lib/geminiQuota.js";

export async function getGeminiApiKeyUsage(connectionId, apiKey, providerSpecificData = null) {
  if (!apiKey) {
    return { message: "Gemini API key not available." };
  }

  if (!connectionId) {
    return {
      message: "Gemini connection not available for quota tracking.",
      quotas: {},
      plan: "Free Tier",
      estimated: true,
    };
  }

  return await buildGeminiApiKeyQuotaUsage(connectionId, null, providerSpecificData);
}
