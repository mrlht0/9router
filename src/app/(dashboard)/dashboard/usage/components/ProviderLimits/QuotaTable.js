"use client";

import { useEffect, useMemo, useState } from "react";
import { GEMINI_MODEL_DISPLAY_ORDER } from "@/shared/constants/geminiQuotaModels.js";
import { formatResetTime, getRemainingPercentage } from "./utils";

const PAGE_SIZE = 10;

function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;

  try {
    const date = new Date(resetTime);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let dayStr = "";
    if (date >= today && date < tomorrow) {
      dayStr = "Today";
    } else if (date >= tomorrow && date < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) {
      dayStr = "Tomorrow";
    } else {
      dayStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}

function getColorClasses(remainingPercentage) {
  if (remainingPercentage > 70) {
    return {
      text: "text-green-600 dark:text-green-400",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "G",
    };
  }

  if (remainingPercentage >= 30) {
    return {
      text: "text-yellow-600 dark:text-yellow-400",
      bg: "bg-yellow-500",
      bgLight: "bg-yellow-500/10",
      emoji: "Y",
    };
  }

  return {
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500",
    bgLight: "bg-red-500/10",
    emoji: "R",
  };
}

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc") {
    return [...quotas].sort((a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name));
  }

  if (sortMode === "remaining-desc") {
    return [...quotas].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }

  return quotas;
}

function isGeminiQuotaSet(quotas) {
  return Array.isArray(quotas)
    && quotas.length > 0
    && quotas.every((quota) => quota?.modelKey && / \| (RPM|TPM|RPD)$/.test(quota?.name || ""));
}

function parseGeminiMetric(quota) {
  const match = (quota?.name || "").match(/^(.*) \| (RPM|TPM|RPD)$/);
  if (!match) return null;
  return {
    modelName: match[1],
    metric: match[2],
  };
}

function renderQuotaValue(quota) {
  if (!quota) return null;
  const total = quota.unlimited ? "inf" : Number(quota.total || 0).toLocaleString();
  return `${quota.used.toLocaleString()} / ${total}`;
}

function GeminiQuotaGrid({ quotas, compact }) {
  const rows = useMemo(() => {
    const grouped = new Map();
    for (const quota of quotas) {
      const parsed = parseGeminiMetric(quota);
      if (!parsed) continue;
      if (!grouped.has(quota.modelKey)) {
        grouped.set(quota.modelKey, {
          modelKey: quota.modelKey,
          modelName: parsed.modelName,
          RPM: null,
          TPM: null,
          RPD: null,
        });
      }
      grouped.get(quota.modelKey)[parsed.metric] = {
        ...quota,
        remaining: getRemainingPercentage(quota),
      };
    }
    const order = new Map(GEMINI_MODEL_DISPLAY_ORDER.map((modelKey, index) => [modelKey, index]));
    return [...grouped.values()].sort((a, b) => {
      const orderA = order.get(a.modelKey) ?? Number.MAX_SAFE_INTEGER;
      const orderB = order.get(b.modelKey) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.modelName.localeCompare(b.modelName);
    });
  }, [quotas]);

  const pad = compact ? "px-1.5 py-1.5" : "px-3 py-2";
  const modelText = compact ? "text-[11px]" : "text-sm";
  const metricText = compact ? "text-[10px]" : "text-xs";

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/5 text-text-muted">
              <th className={`${pad} w-[40%] ${metricText} font-medium`}>Model</th>
              <th className={`${pad} w-[20%] ${metricText} font-medium text-center`}>RPM</th>
              <th className={`${pad} w-[20%] ${metricText} font-medium text-center`}>TPM</th>
              <th className={`${pad} w-[20%] ${metricText} font-medium text-center`}>RPD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.modelKey} className="border-b border-black/5 dark:border-white/5 align-top">
                <td className={`${pad} ${modelText} font-medium text-text-primary`}>{row.modelName}</td>
                {["RPM", "TPM", "RPD"].map((metric) => {
                  const quota = row[metric];
                  const remaining = quota ? getRemainingPercentage(quota) : 0;
                  const colors = getColorClasses(remaining);
                  const countdown = quota ? formatResetTime(quota.resetAt) : "-";
                  return (
                    <td key={metric} className={`${pad} text-center`}>
                      {quota ? (
                        <div className="space-y-1">
                          <div className={`${metricText} font-medium ${colors.text}`}>{metric}</div>
                          <div className={`${metricText} text-text-primary`}>{renderQuotaValue(quota)}</div>
                          <div className={`${metricText} ${colors.text}`}>{remaining}%</div>
                          <div className={`${metricText} text-text-muted`}>{countdown !== "-" ? `in ${countdown}` : "N/A"}</div>
                        </div>
                      ) : (
                        <div className={`${metricText} text-text-muted`}>N/A</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function QuotaTable({
  quotas = [],
  compact = false,
  sortMode = "default",
  showSortLabel = false,
}) {
  const [page, setPage] = useState(1);

  const normalizedQuotas = useMemo(
    () => quotas.map((quota, index) => ({
      ...quota,
      index,
      remaining: getRemainingPercentage(quota),
    })),
    [quotas],
  );

  const sortedQuotas = useMemo(
    () => sortQuotas(normalizedQuotas, sortMode),
    [normalizedQuotas, sortMode],
  );

  const totalPages = Math.max(1, Math.ceil(sortedQuotas.length / PAGE_SIZE));

  useEffect(() => {
    setPage(1);
  }, [sortMode, quotas]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, totalPages));
  }, [totalPages]);

  if (!quotas || quotas.length === 0) {
    return null;
  }

  if (isGeminiQuotaSet(quotas)) {
    return <GeminiQuotaGrid quotas={quotas} compact={compact} />;
  }

  const currentPageRows = sortedQuotas.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );
  const pageStart = sortedQuotas.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, sortedQuotas.length);

  const cellPad = compact ? "py-1 px-1.5" : "py-2 px-3";
  const nameText = compact ? "text-[11px]" : "text-sm";
  const resetPrimary = compact ? "text-[11px]" : "text-sm";
  const resetSecondary = compact ? "text-[10px] leading-tight" : "text-xs";
  const sortLabel = "Sorted by account remaining";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-text-muted">
          {sortedQuotas.length} quota{sortedQuotas.length > 1 ? "s" : ""}
        </div>
        {showSortLabel && (
          <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1 text-[10px] text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
            {sortLabel}
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <tbody>
            {currentPageRows.map((quota) => {
              const colors = getColorClasses(quota.remaining);
              const countdown = formatResetTime(quota.resetAt);
              const resetDisplay = formatResetTimeDisplay(quota.resetAt);

              return (
                <tr
                  key={`${quota.name}-${quota.index}`}
                  className="border-b border-black/5 dark:border-white/5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                >
                  <td className={`${cellPad} w-[30%]`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] shrink-0">{colors.emoji}</span>
                      <span className={`${nameText} font-medium text-text-primary truncate`}>
                        {quota.name}
                      </span>
                    </div>
                  </td>

                  <td className={`${cellPad} w-[45%]`}>
                    <div className={compact ? "space-y-1" : "space-y-1.5"}>
                      <div className={`${compact ? "h-1" : "h-1.5"} rounded-full overflow-hidden border ${colors.bgLight} ${
                        quota.remaining === 0 ? "border-black/10 dark:border-white/10" : "border-transparent"
                      }`}>
                        <div
                          className={`h-full transition-all duration-300 ${colors.bg}`}
                          style={{ width: `${Math.min(quota.remaining, 100)}%` }}
                        />
                      </div>

                      <div className={`flex items-center justify-between ${compact ? "text-[10px]" : "text-xs"}`}>
                        <span className="text-text-muted">
                          {quota.used.toLocaleString()} / {quota.total > 0 ? quota.total.toLocaleString() : "inf"}
                        </span>
                        <span className={`font-medium ${colors.text}`}>
                          {quota.remaining}%
                        </span>
                      </div>
                    </div>
                  </td>

                  <td className={`${cellPad} w-[25%]`}>
                    {countdown !== "-" || resetDisplay ? (
                      compact ? (
                        <div
                          className={`${resetPrimary} text-text-primary font-medium truncate`}
                          title={resetDisplay || ""}
                        >
                          {countdown !== "-" ? `in ${countdown}` : resetDisplay}
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          {countdown !== "-" && (
                            <div className={`${resetPrimary} text-text-primary font-medium`}>
                              in {countdown}
                            </div>
                          )}
                          {resetDisplay && (
                            <div className={`${resetSecondary} text-text-muted`}>
                              {resetDisplay}
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <div className={`${resetPrimary} text-text-muted italic`}>N/A</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
            <span>
              Showing {pageStart}-{pageEnd} of {sortedQuotas.length}
            </span>
            <span>
              Page {page} / {totalPages}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={page === 1}
              className="flex h-6 items-center rounded-md border border-black/10 px-2 text-[10px] text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
              disabled={page === totalPages}
              className="flex h-6 items-center rounded-md border border-black/10 px-2 text-[10px] text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
