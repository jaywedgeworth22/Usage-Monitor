"use client";

import { useEffect, useMemo, useRef } from "react";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";
import CostCoverageLegend from "@/components/CostCoverageLegend";
import DashboardAttentionPanel from "@/components/DashboardAttentionPanel";
import DashboardProviderWorkspace from "@/components/DashboardProviderWorkspace";
import DashboardPortfolioSection from "@/components/DashboardPortfolioSection";
import OperationsOverview from "@/components/OperationsOverview";
import {
  shouldShowDashboardSkeleton,
  useDashboardData,
} from "@/hooks/useDashboardData";
import { sumProviderFunds } from "@/lib/provider-financial-semantics";
import { canonicalProviderKey } from "@/lib/provider-identity";
import { aggregateProviderPortfolioMoney } from "@/lib/provider-money-aggregation";

export default function DashboardPage() {
  const {
    timeframe,
    setTimeframe,
    providers,
    usageSummary,
    projects,
    subscriptions,
    projectSummary,
    portfolioOpen,
    setPortfolioOpen,
    portfolioLoaded,
    portfolioLoading,
    portfolioError,
    loading,
    refreshing,
    error,
    warnings,
    lastUpdatedAt,
    fetchProviders,
    fetchPortfolioData,
    refreshDashboard,
    openAttentionPanel,
  } = useDashboardData();
  const autoOpenedPortfolio = useRef(false);

  const totalProviderFunds = useMemo(() => sumProviderFunds(providers), [providers]);
  const portfolioMoney = useMemo(() => aggregateProviderPortfolioMoney(providers), [providers]);
  const {
    totalCost,
    totalProjectedMonthlyCost,
    ambiguousCostFamilyCount,
    incompleteCostFamilyCount,
  } = portfolioMoney;

  const incompleteCostProviderCount = useMemo(
    () =>
      (providers || []).filter(
        (provider: any) => provider?.isActive && provider?.spendCoverage !== "complete"
      ).length,
    [providers]
  );

  const chartFamilies = useMemo(
    () =>
      (portfolioMoney.families || []).map((family: any) => {
        const members = (providers || []).filter(
          (p: any) => (canonicalProviderKey(p?.name || "") || p?.id) === family?.key
        );
        const displayName =
          members.find((m: any) => m?.displayName)?.displayName ?? family?.displayName;
        return {
          displayName,
          projectedEomUsd: family?.projectedEomUsd,
          exact: family?.exact,
        };
      }),
    [portfolioMoney.families, providers]
  );

  const attentionItems = useMemo(
    () =>
      (providers || [])
        .flatMap((provider: any) =>
          (provider?.alerts || [])
            .filter((alert: any) => alert?.severity !== "info")
            .map((alert: any) => ({ provider, alert }))
        )
        .sort((left: any, right: any) => {
          const severityRank = { critical: 0, warning: 1, info: 2 } as const;
          const leftRank = severityRank[left?.alert?.severity as keyof typeof severityRank] ?? 2;
          const rightRank = severityRank[right?.alert?.severity as keyof typeof severityRank] ?? 2;
          return (
            leftRank - rightRank ||
            (left?.provider?.displayName || "").localeCompare(right?.provider?.displayName || "") ||
            (left?.alert?.message || "").localeCompare(right?.alert?.message || "")
          );
        }),
    [providers]
  );

  const criticalCount = useMemo(
    () => attentionItems.filter((item) => item.alert?.severity === "critical").length,
    [attentionItems]
  );

  // GROK3-D9: default-open Portfolio once when critical alerts or incomplete
  // costs are present. Do not fight a later manual collapse.
  useEffect(() => {
    if (autoOpenedPortfolio.current || loading || portfolioOpen) return;
    if (criticalCount > 0 || incompleteCostFamilyCount > 0 || incompleteCostProviderCount > 0) {
      autoOpenedPortfolio.current = true;
      setPortfolioOpen(true);
    }
  }, [
    criticalCount,
    incompleteCostFamilyCount,
    incompleteCostProviderCount,
    loading,
    portfolioOpen,
    setPortfolioOpen,
  ]);

  const portfolioSummaryParts = [
    `${subscriptions.length} paid service${subscriptions.length === 1 ? "" : "s"}`,
  ];
  if (projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) {
    portfolioSummaryParts.push(`${projects.length} project${projects.length === 1 ? "" : "s"}`);
  }
  portfolioSummaryParts.push(
    `${attentionItems.length} open alert${attentionItems.length === 1 ? "" : "s"}`
  );
  const portfolioSummary = `${portfolioSummaryParts.join(" · ")} · charts & health`;

  // Never blank the dashboard once provider rows are on screen — a later
  // loading=true race was flashing content then sticking on skeletons.
  if (shouldShowDashboardSkeleton({ loading, providerCount: providers.length })) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 dark:bg-gray-700 rounded"></div>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 h-24"></div>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 h-96"></div>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 h-14"></div>
      </div>
    );
  }

  if (error && providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p role="alert" className="text-red-600 dark:text-red-300">{error}</p>
        <button
          type="button"
          onClick={() => fetchProviders()}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        <div className="flex items-center gap-3">
          {lastUpdatedAt && (
            <span className="hidden text-xs text-gray-500 dark:text-gray-400 sm:inline">
              Updated {new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <label htmlFor="dashboard-timeframe-select" className="sr-only">
              Timeframe
            </label>
            <select
              id="dashboard-timeframe-select"
              aria-label="Dashboard timeframe filter"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value as any)}
              className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <option value="1d">Past 24 Hours</option>
              <option value="7d">Past Week</option>
              <option value="30d">Past Month</option>
              <option value="90d">Past 3 Months</option>
              <option value="180d">Past 6 Months</option>
              <option value="all">All Time</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => void refreshDashboard()}
            disabled={refreshing}
            className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.join(" ")}
        </div>
      )}

      <DashboardSummaryCards
        totalProviderFunds={totalProviderFunds}
        totalProjectedMonthlyCost={totalProjectedMonthlyCost}
        totalCost={totalCost}
        incompleteCostProviderCount={
          incompleteCostProviderCount + incompleteCostFamilyCount
        }
        ambiguousCostFamilyCount={ambiguousCostFamilyCount}
        attentionItemsCount={attentionItems.length}
        criticalCount={criticalCount}
        onAlertsNavigate={openAttentionPanel}
      />

      <DashboardAttentionPanel attentionItems={attentionItems} />

      <CostCoverageLegend />

      <DashboardProviderWorkspace providers={providers} subscriptions={subscriptions} />

      <OperationsOverview />

      <DashboardPortfolioSection
        portfolioOpen={portfolioOpen}
        onToggle={setPortfolioOpen}
        portfolioLoading={portfolioLoading}
        portfolioLoaded={portfolioLoaded}
        portfolioError={portfolioError}
        fetchPortfolioData={fetchPortfolioData}
        providers={providers}
        subscriptions={subscriptions}
        usageSummary={usageSummary}
        projects={projects}
        projectSummary={projectSummary}
        chartFamilies={chartFamilies}
        portfolioSummary={portfolioSummary}
        attentionCount={attentionItems.length}
      />
    </div>
  );
}
