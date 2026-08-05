"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardAttentionPanel from "@/components/DashboardAttentionPanel";
import EmptyState from "@/components/EmptyState";
import ListLoadErrorPanel from "@/components/ListLoadErrorPanel";
import type { ProviderBudgetIntel } from "@/lib/format";

export default function AlertsPageClient() {
  const [providers, setProviders] = useState<any[]>([]);
  const [budgetIntelByProviderId, setBudgetIntelByProviderId] = useState<
    Record<string, ProviderBudgetIntel>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providersRes, budgetRes] = await Promise.all([
        fetch("/api/providers?view=dashboard", { cache: "no-store" }),
        fetch("/api/budget-status", { cache: "no-store" }),
      ]);
      if (!providersRes.ok) throw new Error("Failed to load providers");
      const data = await providersRes.json();
      if (!Array.isArray(data)) throw new Error("Unexpected providers response");
      setProviders(data);

      if (budgetRes.ok) {
        const body = await budgetRes.json().catch(() => null);
        if (body && Array.isArray(body.providers)) {
          const map: Record<string, ProviderBudgetIntel> = {};
          for (const row of body.providers) {
            if (!row || typeof row.id !== "string") continue;
            map[row.id] = {
              projectedStatus: row.projectedStatus ?? null,
              projectedRunoutDate: row.projectedRunoutDate ?? null,
              daysUntilBudgetExhausted: row.daysUntilBudgetExhausted ?? null,
            };
          }
          setBudgetIntelByProviderId(map);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const attentionItems = useMemo(
    () =>
      providers
        .flatMap((provider) =>
          (provider?.alerts || [])
            .filter((alert: any) => alert?.severity !== "info")
            .map((alert: any) => ({
              provider: {
                id: String(provider.id),
                displayName: String(provider.displayName || provider.name || "Provider"),
                label: (provider.label ?? null) as string | null,
              },
              alert: {
                severity: (alert.severity === "critical" || alert.severity === "warning"
                  ? alert.severity
                  : "info") as "critical" | "warning" | "info",
                message: String(alert.message || ""),
                code: typeof alert.code === "string" ? alert.code : undefined,
              },
            }))
        )
        .sort((left, right) => {
          const severityRank = { critical: 0, warning: 1, info: 2 } as const;
          return (
            severityRank[left.alert.severity] - severityRank[right.alert.severity] ||
            left.provider.displayName.localeCompare(right.provider.displayName) ||
            left.alert.message.localeCompare(right.alert.message)
          );
        }),
    [providers]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Alerts</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Open attention items across providers — budgets, renewals, and coverage gaps.
          </p>
        </div>
        <Link
          href="/settings?tab=connections"
          className="inline-flex min-h-11 items-center rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Manage budgets
        </Link>
      </div>

      {loading && providers.length === 0 ? (
        <div className="animate-pulse rounded-2xl border border-gray-200 bg-white h-48 dark:border-gray-700 dark:bg-gray-800" />
      ) : error && providers.length === 0 ? (
        <ListLoadErrorPanel
          message="Alerts couldn't be loaded."
          detail={error}
          onRetry={() => void load()}
        />
      ) : attentionItems.length === 0 && !loading ? (
        <EmptyState
          title="All clear"
          message="No critical or warning alerts right now. Overview and provider pages stay in sync with this list."
          action={
            <Link
              href="/"
              className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Back to Overview
            </Link>
          }
        />
      ) : (
        <DashboardAttentionPanel
          attentionItems={attentionItems}
          budgetIntelByProviderId={budgetIntelByProviderId}
        />
      )}
    </div>
  );
}
