"use client";

import { useState } from "react";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Badge from "@/shared/components/Badge";
import QuotaProgressBar from "./QuotaProgressBar";
import { calculatePercentage } from "./utils";

const planVariants = {
  free: "default",
  pro: "primary",
  ultra: "success",
  enterprise: "info",
};

export default function ProviderLimitCard({
  provider,
  name,
  plan,
  quotas = [],
  message = null,
  loading = false,
  error = null,
  onRefresh,
  onRefreshToken,
  tokenRefreshing = false,
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;

    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Get provider info from config
  const getProviderColor = () => {
    const colors = {
      github: "#000000",
      antigravity: "#4285F4",
      codex: "#10A37F",
      kiro: "#FF9900",
      claude: "#D97757",
    };
    return colors[provider?.toLowerCase()] || "#6B7280";
  };

  const providerColor = getProviderColor();
  const planVariant = planVariants[plan?.toLowerCase()] || "default";
  const isCodex = provider?.toLowerCase() === "codex";
  const isAuthError = error && /401|unauthoriz|expired|token/i.test(String(error));

  return (
    <Card padding="md" className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Provider Logo */}
          <div
            className="size-10 rounded-lg flex items-center justify-center p-1.5"
            style={{ backgroundColor: `${providerColor}15` }}
          >
            <ProviderIcon
              src={`/providers/${provider}.png`}
              alt={provider || "Provider"}
              size={40}
              className="object-contain rounded-lg"
              fallbackText={provider?.slice(0, 2).toUpperCase() || "PR"}
              fallbackColor={providerColor}
            />
          </div>

          <div>
            <h3 className="font-semibold text-text-primary">
              {name || provider}
            </h3>
            {plan && (
              <Badge
                variant={planVariants[plan?.toLowerCase()] || "default"}
                size="xs"
              >
                {plan}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {isCodex && onRefreshToken && (
            <button
              onClick={onRefreshToken}
              disabled={tokenRefreshing}
              className="inline-flex items-center gap-1 rounded-lg border border-primary/20 bg-primary/10 px-2.5 py-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh Codex access token"
            >
              <span className={`material-symbols-outlined text-[16px] ${tokenRefreshing ? "animate-spin" : ""}`}>
                {tokenRefreshing ? "sync" : "key"}
              </span>
              <span className="hidden sm:inline">Refresh Token</span>
            </button>
          )}

          {/* Refresh Quota Button */}
          <button
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Refresh quota only"
          >
            <span
              className={`material-symbols-outlined text-[20px] text-text-muted ${
                refreshing || loading ? "animate-spin" : ""
              }`}
            >
              refresh
            </span>
          </button>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="h-4 bg-black/5 dark:bg-white/5 rounded animate-pulse" />
            <div className="h-2 bg-black/5 dark:bg-white/5 rounded animate-pulse" />
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-black/5 dark:bg-white/5 rounded animate-pulse" />
            <div className="h-2 bg-black/5 dark:bg-white/5 rounded animate-pulse" />
          </div>
        </div>
      )}

      {/* Error State */}
      {!loading && error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-red-500 text-[20px]">
              error
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              {isCodex && isAuthError && onRefreshToken && (
                <button
                  onClick={onRefreshToken}
                  disabled={tokenRefreshing}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-500/15 dark:text-red-300 disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[16px] ${tokenRefreshing ? "animate-spin" : ""}`}>
                    {tokenRefreshing ? "sync" : "key"}
                  </span>
                  Refresh Codex Token
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Info Message (for providers without API) */}
      {!loading && !error && message && (
        <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-blue-500 text-[20px]">
              info
            </span>
            <p className="text-sm text-blue-600 dark:text-blue-400">
              {message}
            </p>
          </div>
        </div>
      )}

      {/* Quota Progress Bars */}
      {!loading && !error && !message && quotas?.length > 0 && (
        <div className="space-y-4">
          {quotas.map((quota, index) => {
            // For Antigravity, use remainingPercentage if available, otherwise calculate
            const percentage =
              quota.remainingPercentage !== undefined
                ? Math.round(((quota.total - quota.used) / quota.total) * 100)
                : calculatePercentage(quota.used, quota.total);
            const unlimited = quota.total === 0 || quota.total === null;

            return (
              <QuotaProgressBar
                key={`${quota.name}-${index}`}
                label={quota.name}
                used={quota.used}
                total={quota.total}
                percentage={percentage}
                unlimited={unlimited}
                resetTime={quota.resetAt}
              />
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && !message && quotas?.length === 0 && (
        <div className="text-center py-8 text-text-muted">
          <span className="material-symbols-outlined text-[48px] opacity-20">
            data_usage
          </span>
          <p className="text-sm mt-2">No quota data available</p>
        </div>
      )}
    </Card>
  );
}
