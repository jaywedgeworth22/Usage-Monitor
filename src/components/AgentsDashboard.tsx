"use client";

import React, { useEffect, useState } from "react";
import type { AgentsOverviewResponse, AgentPlatformStatus } from "@/lib/agents-overview";

export function AgentsDashboard() {
  const [data, setData] = useState<AgentsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowParam, setWindowParam] = useState<"5h" | "24h" | "7d" | "30d" | "all">("30d");
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);

  useEffect(() => {
    let unmounted = false;
    const fetchOverview = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/agents-overview?window=${windowParam}`);
        if (res.ok) {
          const json = await res.json();
          if (!unmounted) setData(json);
        }
      } catch (err) {
        console.error("Failed to load agents overview", err);
      } finally {
        if (!unmounted) setLoading(false);
      }
    };

    fetchOverview();
    const interval = setInterval(fetchOverview, 30_000);
    return () => {
      unmounted = true;
      clearInterval(interval);
    };
  }, [windowParam]);

  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return tokens.toLocaleString();
  };

  const formatCurrency = (usd: number) => {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(usd);
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Window Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            <span>🤖</span>
            <span>AI Coding Agents</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live local process execution, model token telemetry, quota burn windows, and PAYG API-equivalent cost savings.
          </p>
        </div>

        {/* Time Window Switcher */}
        <div className="inline-flex rounded-lg bg-muted p-1 text-xs font-medium self-start sm:self-auto">
          {(["5h", "24h", "7d", "30d", "all"] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWindowParam(w)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                windowParam === w
                  ? "bg-background text-foreground shadow-sm font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {w === "5h" ? "5 Hours" : w === "24h" ? "24h" : w === "7d" ? "7 Days" : w === "30d" ? "30 Days" : "All Time"}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-pulse">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 rounded-xl bg-card border border-border p-4" />
          ))}
        </div>
      ) : data ? (
        <>
          {/* Key Metrics Hero */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Live Agents Online */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Active on Mac</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {data.macChip}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-foreground">
                  {data.summary.activeAgentCount}
                </span>
                <span className="text-xs text-muted-foreground">
                  of {data.summary.totalAgentCount} platforms running
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {data.platforms.map((p) => (
                  <span
                    key={p.id}
                    className={`h-2 w-2 rounded-full ${
                      p.isRunningOnMac ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700"
                    }`}
                    title={`${p.name}: ${p.isRunningOnMac ? "Running" : "Idle"}`}
                  />
                ))}
              </div>
            </div>

            {/* Total Tokens */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Total Tokens Processed</span>
                <span className="text-[11px] text-muted-foreground font-mono">{data.windowLabel}</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {formatTokens(data.summary.totalTokens)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground truncate">
                Top Model: <span className="font-mono text-foreground font-medium">{data.summary.topModel || "None"}</span>
              </div>
            </div>

            {/* API Equivalent Value */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">PAYG API Equivalent</span>
                <span className="text-[11px] text-muted-foreground">LiteLLM Catalog</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {formatCurrency(data.summary.totalApiEquivalentCostUsd)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Subscription seats: {formatCurrency(data.summary.totalSubscriptionCostUsd)}
              </div>
            </div>

            {/* Net Subscription Savings */}
            <div className="rounded-xl border border-border bg-emerald-500/5 dark:bg-emerald-500/10 p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">Net Subscription Savings</span>
                <span className="inline-flex rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  {data.summary.savingsMultiplier}x ROI
                </span>
              </div>
              <div className="mt-2 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                +{formatCurrency(data.summary.totalNetSavingsUsd)}
              </div>
              <div className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/80">
                Saved vs paying direct API list pricing
              </div>
            </div>
          </div>

          {/* 5-Hour Quota Burn Window */}
          {data.burn5h.tokens5h > 0 && (
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                  <h3 className="text-sm font-semibold text-foreground">Trailing 5-Hour Rolling Activity & Burn</h3>
                </div>
                <span className="text-xs text-muted-foreground">ccusage block standard</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-border/50 text-center">
                <div>
                  <div className="text-[11px] text-muted-foreground">5h Token Volume</div>
                  <div className="text-lg font-bold text-foreground mt-0.5">{formatTokens(data.burn5h.tokens5h)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">5h Cost Equivalent</div>
                  <div className="text-lg font-bold text-foreground mt-0.5">{formatCurrency(data.burn5h.costEstimate5hUsd)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Token Pace / hr</div>
                  <div className="text-lg font-bold text-foreground mt-0.5">{formatTokens(data.burn5h.burnRateTokensPerHour)}/h</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Burn Rate / hr</div>
                  <div className="text-lg font-bold text-foreground mt-0.5">{formatCurrency(data.burn5h.burnRateUsdPerHour)}/h</div>
                </div>
              </div>
            </div>
          )}

          {/* Agent Platforms Grid */}
          <div>
            <h2 className="text-base font-bold text-foreground mb-3 flex items-center justify-between">
              <span>Agentic Coding Platforms</span>
              <span className="text-xs font-normal text-muted-foreground">
                Showing live status & telemetry for all {data.platforms.length} seats
              </span>
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {data.platforms.map((platform) => {
                const isExpanded = expandedPlatform === platform.id;
                return (
                  <div
                    key={platform.id}
                    className="rounded-xl border border-border bg-card p-4 shadow-sm flex flex-col justify-between transition-all"
                  >
                    <div>
                      {/* Platform Header */}
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-foreground text-sm">{platform.name}</h3>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {platform.provider}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">{platform.notes}</p>
                        </div>

                        {/* Status Badge */}
                        <div className="text-right">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                              platform.isRunningOnMac
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                platform.isRunningOnMac ? "bg-emerald-500 animate-pulse" : "bg-slate-400"
                              }`}
                            />
                            {platform.isRunningOnMac ? "Active on Mac" : "Idle on Mac"}
                          </span>
                        </div>
                      </div>

                      {/* Stats Overview */}
                      <div className="mt-3.5 grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-2.5 text-center text-xs">
                        <div>
                          <div className="text-[10px] text-muted-foreground">Tokens</div>
                          <div className="font-bold text-foreground mt-0.5">{formatTokens(platform.totalTokens)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground">PAYG Value</div>
                          <div className="font-bold text-foreground mt-0.5">{formatCurrency(platform.estimatedCostUsd)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground">Seat Cost</div>
                          <div className="font-bold text-foreground mt-0.5">${platform.monthlySeatCostUsd}/mo</div>
                        </div>
                      </div>

                      {/* Model Usage Breakdown */}
                      {platform.modelsUsed.length > 0 && (
                        <div className="mt-3">
                          <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex justify-between">
                            <span>Models Used</span>
                            <span>{platform.modelsUsed.length} model(s)</span>
                          </div>
                          <div className="space-y-1.5">
                            {platform.modelsUsed.slice(0, isExpanded ? undefined : 2).map((m) => (
                              <div key={m.model} className="text-xs">
                                <div className="flex justify-between font-mono text-[11px] text-muted-foreground mb-0.5">
                                  <span className="truncate max-w-[200px] text-foreground font-medium">{m.model}</span>
                                  <span>{formatTokens(m.tokens)} ({m.percentOfPlatform.toFixed(0)}%)</span>
                                </div>
                                <div className="w-full bg-muted h-1 rounded-full overflow-hidden">
                                  <div
                                    className="bg-primary h-full rounded-full"
                                    style={{ width: `${Math.max(2, m.percentOfPlatform)}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          {platform.modelsUsed.length > 2 && (
                            <button
                              onClick={() => setExpandedPlatform(isExpanded ? null : platform.id)}
                              className="mt-1.5 text-[11px] font-medium text-primary hover:underline"
                            >
                              {isExpanded ? "Show fewer models" : `+${platform.modelsUsed.length - 2} more model(s)`}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Data Capability Footnote */}
                    <div className="mt-3.5 pt-2.5 border-t border-border/50 text-[11px] text-muted-foreground flex items-center justify-between">
                      <span className="truncate pr-2" title={platform.notes}>
                        ℹ️ {platform.dataCapability}
                      </span>
                      <span className="capitalize font-mono text-[10px] bg-muted/60 px-1.5 py-0.5 rounded flex-shrink-0">
                        {platform.fidelityTier.replace(/_/g, " ")}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Model Distribution Table */}
          {data.modelDistribution.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <h2 className="text-base font-bold text-foreground mb-3">Model Consumption Distribution</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-medium">Model</th>
                      <th className="pb-2 font-medium">Provider</th>
                      <th className="pb-2 font-medium text-right">Tokens</th>
                      <th className="pb-2 font-medium text-right">Share (%)</th>
                      <th className="pb-2 font-medium text-right">API Equivalent Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50 font-mono">
                    {data.modelDistribution.map((m) => (
                      <tr key={m.model} className="hover:bg-muted/30">
                        <td className="py-2.5 font-semibold text-foreground">{m.model}</td>
                        <td className="py-2.5 text-muted-foreground">{m.provider}</td>
                        <td className="py-2.5 text-right font-medium text-foreground">{formatTokens(m.tokens)}</td>
                        <td className="py-2.5 text-right text-muted-foreground">{m.percent.toFixed(1)}%</td>
                        <td className="py-2.5 text-right text-emerald-600 dark:text-emerald-400 font-semibold">
                          {formatCurrency(m.apiEquivalentCostUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
