"use client";

import { useEffect, useState } from "react";

interface ModelCostCheck {
  model: string;
  pricingKey: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    unknown: number;
  };
  derivedCostUsd: number;
  derivationComplete: boolean;
  reportedCostUsd: number;
  deltaUsd: number;
  deltaPct: number | null;
}

interface ClaudeCostCheckResponse {
  ok: boolean;
  days: number;
  pricing: { source: string; fetchedAt: string; upstreamSha256: string };
  models: ModelCostCheck[];
  totals: {
    derivedCostUsd: number;
    reportedCostUsd: number;
    deltaUsd: number;
    deltaPct: number | null;
    unpricedModelCount: number;
  };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function totalTokens(model: ModelCostCheck): number {
  return (
    model.tokens.input +
    model.tokens.output +
    model.tokens.cacheRead +
    model.tokens.cacheCreation +
    model.tokens.unknown
  );
}

function driftTone(model: ModelCostCheck): {
  chip: string;
  label: string;
} {
  if (!model.derivationComplete) {
    return {
      chip: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
      label: model.pricingKey ? "partial" : "unpriced",
    };
  }
  const pct = model.deltaPct == null ? 0 : Math.abs(model.deltaPct);
  if (pct < 0.05) {
    return {
      chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
      label: "in agreement",
    };
  }
  if (pct < 0.15) {
    return {
      chip: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      label: "drifting",
    };
  }
  return {
    chip: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    label: "diverged",
  };
}

/**
 * Per-model cross-check of Claude Code's own OTLP cost estimate against an
 * independent token x LiteLLM-catalog derivation (the ccusage lesson: never
 * trust one cost signal). Both figures are analytics-only API-equivalent
 * estimates — the card exists to surface DRIFT between them, not to state
 * cash spend. Renders nothing when no Claude Code OTLP data exists.
 */
export default function ClaudeCostCheckCard() {
  const [data, setData] = useState<ClaudeCostCheckResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude-cost-check?days=30")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || !data.ok || data.models.length === 0) return null;

  const snapshotDate = new Date(data.pricing.fetchedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const totalPct = data.totals.deltaPct;
  const visibleModels = data.models.slice(0, 6);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Claude Cost Cross-Check
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Last {data.days} {data.days === 1 ? "day" : "days"} · token × LiteLLM pricing vs Claude-reported estimate
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Overall drift
          </p>
          <p
            className={`text-sm font-semibold ${
              totalPct != null && Math.abs(totalPct) >= 0.15
                ? "text-red-600 dark:text-red-400"
                : totalPct != null && Math.abs(totalPct) >= 0.05
                ? "text-amber-600 dark:text-amber-400"
                : "text-gray-900 dark:text-gray-100"
            }`}
          >
            {totalPct == null
              ? "—"
              : `${totalPct >= 0 ? "+" : ""}${(totalPct * 100).toFixed(1)}%`}
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse responsive-table">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Model
              </th>
              <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                Tokens
              </th>
              <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                Derived
              </th>
              <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                Reported
              </th>
              <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                Drift
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {visibleModels.map((model) => {
              const tone = driftTone(model);
              return (
                <tr key={model.model} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  <td className="px-6 py-3" data-label="Model">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {model.model}
                    </p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                      {model.pricingKey
                        ? model.pricingKey === model.model
                          ? "priced"
                          : `priced as ${model.pricingKey}`
                        : "not in pricing catalog"}
                    </p>
                  </td>
                  <td className="px-6 py-3 text-right" data-label="Tokens">
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      {compact.format(totalTokens(model))}
                    </p>
                  </td>
                  <td className="px-6 py-3 text-right" data-label="Derived">
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      {usd.format(model.derivedCostUsd)}
                    </p>
                  </td>
                  <td className="px-6 py-3 text-right" data-label="Reported">
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      {usd.format(model.reportedCostUsd)}
                    </p>
                  </td>
                  <td className="px-6 py-3 text-right" data-label="Drift">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {model.deltaPct == null
                        ? "—"
                        : `${model.deltaPct >= 0 ? "+" : ""}${(model.deltaPct * 100).toFixed(1)}%`}
                    </p>
                    <span
                      className={`inline-flex mt-1 px-2 py-0.5 text-[10px] font-medium rounded-full ${tone.chip}`}
                    >
                      {tone.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-700">
        <p className="text-[10px] text-gray-500 dark:text-gray-400">
          Both figures are API-equivalent analytics estimates, excluded from cash spend. Derived
          from the bundled LiteLLM catalog refreshed {snapshotDate}
          {data.totals.unpricedModelCount > 0
            ? ` · ${data.totals.unpricedModelCount} unpriced model${data.totals.unpricedModelCount === 1 ? "" : "s"} under-counts derivation`
            : ""}
          {data.models.length > visibleModels.length
            ? ` · showing top ${visibleModels.length} of ${data.models.length} models`
            : ""}
          .
        </p>
      </div>
    </div>
  );
}
