/**
 * Gemini API Key Usage Handler
 *
 * As of 2026-06-22, Google AI Studio's public API does not provide a direct
 * endpoint to programmatically fetch quota information for individual API keys.
 * Users typically check their rate limits manually on the AI Studio website.
 *
 * This handler will return an informational message guiding the user to the
 * manual rate limit page, following the pattern of other providers where
 * direct API key quota fetching is not available (e.g., Ollama).
 *
 * In the future, if a public API becomes available, this function can be updated.
 */

import { U } from "./shared.js";

// URL for manual rate limit checking on Google AI Studio
const GEMINI_AI_STUDIO_RATE_LIMIT_URL = "https://aistudio.google.com/app/rate-limit";

/**
 * Get usage data for a Gemini API Key connection.
 * @param {string} apiKey - The Gemini API key.
 * @returns {Object} Usage data with an informational message.
 */
export async function getGeminiApiKeyUsage(apiKey) {
  if (!apiKey) {
    return { message: "Gemini API key not available." };
  }

  // Return a message guiding the user to the manual rate limit page.
  return {
    message: `Gemini API key usage can only be tracked manually. Visit ${GEMINI_AI_STUDIO_RATE_LIMIT_URL} for details.`,
    quotas: [], // Empty quotas array to indicate no programmatic data
    plan: "Free Tier / Pay-as-you-go", // Default plan or infer if possible
  };
}
