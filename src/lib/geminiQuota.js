import { GEMINI_MODEL_DISPLAY_ORDER } from "@/shared/constants/geminiQuotaModels.js";

const GEMINI_FREE_TIER_LIMITS = {
  "gemini-3.5-flash": { label: "Gemini 3.5 Flash", rpm: 5, tpm: 250000, rpd: 20 },
  "gemini-2.5-flash-lite": { label: "Gemini 2.5 Flash Lite", rpm: 10, tpm: 250000, rpd: 20 },
  "gemini-3.1-flash-lite": { label: "Gemini 3.1 Flash Lite", rpm: 15, tpm: 250000, rpd: 500 },
  "gemma-4-26b": { label: "Gemma 4 26B", rpm: 15, tpm: Number.POSITIVE_INFINITY, rpd: 1500 },
  "antigravity": { label: "Antigravity", rpm: 0, tpm: 0, rpd: 0 },
  "deep-research-pro-preview": { label: "Deep Research Pro Preview", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-2-flash": { label: "Gemini 2 Flash", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-2-flash-lite": { label: "Gemini 2 Flash Lite", rpm: 0, tpm: 0, rpd: 0 },
  "computer-use-preview": { label: "Computer Use Preview", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-2.5-flash": { label: "Gemini 2.5 Flash", rpm: 5, tpm: 250000, rpd: 20 },
  "gemini-2.5-flash-image": { label: "Nano Banana (Gemini 2.5 Flash Preview Image)", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-2.5-flash-tts": { label: "Gemini 2.5 Flash TTS", rpm: 3, tpm: 10000, rpd: 10 },
  "gemini-2.5-pro": { label: "Gemini 2.5 Pro", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-2.5-pro-tts": { label: "Gemini 2.5 Pro TTS", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-3-flash": { label: "Gemini 3 Flash", rpm: 5, tpm: 250000, rpd: 20 },
  "gemini-3-pro-image": { label: "Nano Banana Pro (Gemini 3 Pro Image)", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-3.1-pro": { label: "Gemini 3.1 Pro", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-3.1-flash-image": { label: "Nano Banana 2 (Gemini 3.1 Flash Image)", rpm: 0, tpm: 0, rpd: 0 },
  "gemini-3.1-flash-tts": { label: "Gemini 3.1 Flash TTS", rpm: 3, tpm: 10000, rpd: 10 },
  "gemini-embedding-1": { label: "Gemini Embedding 1", rpm: 100, tpm: 30000, rpd: 1000 },
  "gemini-embedding-2": { label: "Gemini Embedding 2", rpm: 100, tpm: 30000, rpd: 1000 },
  "gemini-robotics-er-1.5-preview": { label: "Gemini Robotics ER 1.5 Preview", rpm: 10, tpm: 250000, rpd: 20 },
  "gemini-robotics-er-1.6-preview": { label: "Gemini Robotics ER 1.6 Preview", rpm: 5, tpm: 250000, rpd: 20 },
  "gemma-4-31b": { label: "Gemma 4 31B", rpm: 15, tpm: Number.POSITIVE_INFINITY, rpd: 1500 },
};

const GEMINI_MODEL_ALIASES = {
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3.1-pro-preview": "gemini-3.1-pro",
  "gemini-2.5-flash-preview-tts": "gemini-2.5-flash-tts",
  "gemini-2.5-pro-preview-tts": "gemini-2.5-pro-tts",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
  "gemini-embedding-001": "gemini-embedding-1",
  "gemini-embedding-2-preview": "gemini-embedding-2",
  "gemma-4-31b-it": "gemma-4-31b",
  "gemma-4-26b-a4b-it": "gemma-4-26b",
};

function normalizeGeminiModelId(model) {
  if (!model || typeof model !== "string") return null;
  const cleaned = model.trim().replace(/^gemini\//, "");
  return GEMINI_MODEL_ALIASES[cleaned] || cleaned;
}

function getModelLimit(model) {
  const normalized = normalizeGeminiModelId(model);
  if (!normalized) return null;
  const limit = GEMINI_FREE_TIER_LIMITS[normalized];
  return limit ? { modelId: normalized, ...limit } : null;
}

function getMinuteResetAt(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return next.toISOString();
}

function getDayResetAt(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.toISOString();
}

function buildEmptyWindow() {
  return { rpm: 0, tpm: 0, rpd: 0 };
}

function usageFromEntry(entry) {
  const prompt = Number(entry?.tokens?.prompt_tokens || entry?.tokens?.input_tokens || 0);
  const completion = Number(entry?.tokens?.completion_tokens || entry?.tokens?.output_tokens || 0);
  return { requests: 1, tokens: prompt + completion };
}

export async function getGeminiConnectionQuotaSnapshot(connectionId, model, options = {}) {
  const limit = getModelLimit(model);
  if (!connectionId || !limit) {
    return {
      modelId: normalizeGeminiModelId(model),
      limit,
      usage: buildEmptyWindow(),
      depleted: false,
      resetAt: null,
      dimension: null,
    };
  }

  const { getUsageHistory } = await import("@/lib/usageDb.js");
  const history = await getUsageHistory({ provider: "gemini" });
  const now = options.now ? new Date(options.now) : new Date();
  const minuteAgo = now.getTime() - 60 * 1000;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const usage = buildEmptyWindow();
  for (const entry of history) {
    if (entry?.connectionId !== connectionId) continue;
    if (normalizeGeminiModelId(entry?.model) !== limit.modelId) continue;
    const ts = new Date(entry.timestamp || 0).getTime();
    if (!Number.isFinite(ts)) continue;
    const measured = usageFromEntry(entry);
    if (ts >= minuteAgo) {
      usage.rpm += measured.requests;
      usage.tpm += measured.tokens;
    }
    if (ts >= dayStart.getTime()) {
      usage.rpd += measured.requests;
    }
  }

  const limits = { rpm: limit.rpm, tpm: limit.tpm, rpd: limit.rpd };
  const depletedReasons = [];
  if (Number.isFinite(limits.rpm) && limits.rpm >= 0 && usage.rpm >= limits.rpm) depletedReasons.push({ dimension: "rpm", resetAt: getMinuteResetAt(now) });
  if (Number.isFinite(limits.tpm) && limits.tpm >= 0 && usage.tpm >= limits.tpm) depletedReasons.push({ dimension: "tpm", resetAt: getMinuteResetAt(now) });
  if (Number.isFinite(limits.rpd) && limits.rpd >= 0 && usage.rpd >= limits.rpd) depletedReasons.push({ dimension: "rpd", resetAt: getDayResetAt(now) });
  if (limits.rpm === 0 && limits.tpm === 0 && limits.rpd === 0) {
    depletedReasons.push({ dimension: "free-tier-disabled", resetAt: getDayResetAt(now) });
  }

  return {
    modelId: limit.modelId,
    limit,
    usage,
    depleted: depletedReasons.length > 0,
    dimension: depletedReasons[0]?.dimension || null,
    resetAt: depletedReasons[0]?.resetAt || null,
  };
}

function quotaRow(name, used, total, resetAt, extra = {}) {
  const safeUsed = Number.isFinite(used) ? used : 0;
  const unlimited = total === Number.POSITIVE_INFINITY;
  const safeTotal = unlimited ? null : Number(total || 0);
  return {
    name,
    used: safeUsed,
    total: safeTotal,
    resetAt,
    ...(unlimited ? { remainingPercentage: 100, unlimited: true } : {}),
    ...(!unlimited && safeTotal > 0 ? { remaining: Math.max(0, Math.round(((safeTotal - safeUsed) / safeTotal) * 100)) } : {}),
    ...extra,
  };
}

export async function buildGeminiApiKeyQuotaUsage(connectionId, modelFilter = null, providerSpecificData = null) {
  let activeModels;

  if (modelFilter) {
    activeModels = [modelFilter];
  } else {
    // 1. Get registry models for gemini
    let registryModels = [];
    try {
      const { getModelsByProviderId } = await import("@/shared/constants/models.js");
      registryModels = getModelsByProviderId("gemini").map((m) => m.id);
    } catch (err) {
      console.error("Error reading registry models for Gemini:", err);
    }

    // 2. Get custom models from modelAliases in DB
    let customModelIds = [];
    try {
      const { getModelAliases } = await import("@/lib/localDb.js");
      const modelAliases = await getModelAliases();
      const prefix = "gemini/";
      customModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => typeof fullModel === "string" && fullModel.startsWith(prefix))
        .map((fullModel) => fullModel.slice(prefix.length));
    } catch (err) {
      console.error("Error reading model aliases for Gemini quota:", err);
    }

    // 3. Combine registry models and custom models
    const combinedModels = [...new Set([...registryModels, ...customModelIds])];

    // 4. Filter out globally disabled models
    let disabledSet = new Set();
    try {
      const { getDisabledByProvider } = await import("@/lib/disabledModelsDb.js");
      const disabledList = await getDisabledByProvider("gemini");
      disabledSet = new Set((disabledList || []).map((id) => normalizeGeminiModelId(id)));
    } catch (err) {
      console.error("Error reading disabled models for Gemini quota:", err);
    }

    const normalizedAndFiltered = combinedModels
      .map((modelId) => normalizeGeminiModelId(modelId))
      .filter((modelId) => modelId && GEMINI_FREE_TIER_LIMITS[modelId] && !disabledSet.has(modelId));

    const uniqueSelected = [...new Set(normalizedAndFiltered)];
    activeModels = GEMINI_MODEL_DISPLAY_ORDER.filter((modelId) => uniqueSelected.includes(modelId));
  }

  const quotas = {};
  for (const rawModel of activeModels) {
    const snapshot = await getGeminiConnectionQuotaSnapshot(connectionId, rawModel);
    const limit = snapshot.limit;
    if (!limit) continue;
    const label = limit.label;
    quotas[`${limit.modelId}:rpm`] = quotaRow(`${label} | RPM`, snapshot.usage.rpm, limit.rpm, getMinuteResetAt(), { modelKey: limit.modelId, unit: "requests/min" });
    quotas[`${limit.modelId}:tpm`] = quotaRow(`${label} | TPM`, snapshot.usage.tpm, limit.tpm, getMinuteResetAt(), { modelKey: limit.modelId, unit: "tokens/min" });
    quotas[`${limit.modelId}:rpd`] = quotaRow(`${label} | RPD`, snapshot.usage.rpd, limit.rpd, getDayResetAt(), { modelKey: limit.modelId, unit: "requests/day" });
  }

  return {
    plan: "Free Tier",
    estimated: true,
    quotas,
  };
}

export {
  GEMINI_FREE_TIER_LIMITS,
  GEMINI_MODEL_ALIASES,
  GEMINI_MODEL_DISPLAY_ORDER,
  normalizeGeminiModelId,
  getModelLimit as getGeminiFreeTierLimit,
  getMinuteResetAt,
  getDayResetAt,
};
