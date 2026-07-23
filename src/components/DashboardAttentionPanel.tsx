"use client";

import Link from "next/link";

interface AttentionItem {
  provider: { id: string; displayName: string; label: string | null };
  alert: { severity: "critical" | "warning" | "info"; message: string };
}

export default function DashboardAttentionPanel({
  attentionItems,
}: {
  attentionItems: AttentionItem[];
}) {
  return (
    <div
      id="attention"
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
    >
      <div className="px-4 py-3 sm:px-6 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          Attention
        </h2>
        <Link
          href="/settings"
          className="text-xs font-medium text-blue-600 dark:text-blue-400"
        >
          Manage budgets
        </Link>
      </div>
      {attentionItems.length === 0 ? (
        <div className="px-4 py-4 sm:px-6 text-sm text-gray-500 dark:text-gray-400">
          No payment, budget, or limit alerts.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {attentionItems.slice(0, 8).map(({ provider, alert }, index) => (
            <div
              key={`${provider.id}-${index}-${alert.message.slice(0, 24)}`}
              className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-6 hover:bg-gray-50 dark:hover:bg-gray-900/40"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {provider.displayName}
                  {provider.label ? ` - ${provider.label}` : ""}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {alert.message}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <Link
                    href={`/providers/${provider.id}`}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400"
                  >
                    Open provider
                  </Link>
                  <Link
                    href={`/providers/${provider.id}`}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400"
                  >
                    Edit budget
                  </Link>
                </div>
              </div>
              <span
                className={`text-xs font-medium px-2 py-1 rounded-full shrink-0 ${
                  alert.severity === "critical"
                    ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                    : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                }`}
              >
                {alert.severity}
              </span>
            </div>
          ))}
          {attentionItems.length > 8 && (
            <div className="px-4 py-3 sm:px-6 text-xs text-gray-500 dark:text-gray-400">
              +{attentionItems.length - 8} more — open a provider or filter
              the workspace by Alerts only.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
