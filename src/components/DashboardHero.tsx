import { formatCurrency } from "@/lib/format";
import {
  accountStatusLabel,
  accountStatusToSemantic,
  spendAmountClass,
  type OverallAccountStatus,
} from "@/lib/ui-status";
import StatusBadge from "@/components/StatusBadge";

interface DashboardHeroProps {
  totalCost: number;
  totalProjectedMonthlyCost: number;
  totalBudgetUsd: number | null;
  budgetedProviderCount: number;
  incompleteCostProviderCount: number;
  ambiguousCostFamilyCount: number;
  accountStatus: OverallAccountStatus;
  spendPeriodLabel: string;
  /** Calendar month name for locked MTD hero (always current UTC month budgets). */
  mtdMonthLabel: string;
}

/**
 * Account-level Overview hero — large MTD spend, budget meter, status pill.
 * Mirrors iOS DashboardHeroCard. Month-to-date budget math is always current
 * calendar month; the timeframe picker elsewhere only affects history/telemetry.
 */
export default function DashboardHero({
  totalCost,
  totalProjectedMonthlyCost,
  totalBudgetUsd,
  budgetedProviderCount,
  incompleteCostProviderCount,
  ambiguousCostFamilyCount,
  accountStatus,
  spendPeriodLabel,
  mtdMonthLabel,
}: DashboardHeroProps) {
  const incomplete = incompleteCostProviderCount > 0 || ambiguousCostFamilyCount > 0;
  const hasBudget = totalBudgetUsd != null && totalBudgetUsd > 0;
  const fraction = hasBudget ? Math.min(totalCost / (totalBudgetUsd as number), 1.5) : 0;
  const meterPct = Math.min(fraction * 100, 100);
  const remaining = hasBudget ? (totalBudgetUsd as number) - totalCost : null;
  const semantic = accountStatusToSemantic(accountStatus);
  const spendClass = spendAmountClass(accountStatus, incomplete);

  const meterFill =
    accountStatus === "exceeded"
      ? "bg-red-500 dark:bg-red-400"
      : accountStatus === "warning"
        ? "bg-amber-500 dark:bg-amber-400"
        : "bg-emerald-500 dark:bg-emerald-400";

  return (
    <section
      aria-labelledby="overview-hero-heading"
      className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6 dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p
            id="overview-hero-heading"
            className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            {incomplete ? `Known ${mtdMonthLabel} spend` : `${mtdMonthLabel} spend`}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Month-to-date budgets (UTC). History window below is separate.
          </p>
        </div>
        <StatusBadge label={accountStatusLabel(accountStatus)} status={semantic} />
      </div>

      <p
        className={`mt-3 text-3xl font-bold tabular-nums tracking-tight sm:text-4xl ${spendClass}`}
      >
        {formatCurrency(totalCost)}
      </p>

      {hasBudget ? (
        <div className="mt-4 space-y-2">
          <div
            className="h-3.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
            role="meter"
            aria-valuenow={Math.round(meterPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Budget used"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${meterFill}`}
              style={{ width: `${meterPct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span className="tabular-nums">
              {formatCurrency(totalCost)} of {formatCurrency(totalBudgetUsd)}
              {budgetedProviderCount > 0 && (
                <span className="ml-1">
                  · across {budgetedProviderCount} provider budget
                  {budgetedProviderCount === 1 ? "" : "s"}
                </span>
              )}
            </span>
            {remaining != null && (
              <span
                className={
                  remaining < 0
                    ? "font-semibold text-red-600 dark:text-red-400"
                    : "font-medium text-gray-700 dark:text-gray-200"
                }
              >
                {remaining < 0
                  ? `${formatCurrency(Math.abs(remaining))} over`
                  : `${formatCurrency(remaining)} left`}
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          No monthly provider budgets configured yet. Tracked spend still appears
          below — set budgets in Settings → Connections.
        </p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 sm:grid-cols-3 dark:border-gray-700">
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            {incomplete ? "Known-cost projection" : "Projected month end"}
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {formatCurrency(totalProjectedMonthlyCost)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            History window
          </p>
          <p className="mt-0.5 text-sm font-medium text-gray-700 dark:text-gray-200">
            {spendPeriodLabel}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
            Charts &amp; telemetry only
          </p>
        </div>
        {(incompleteCostProviderCount > 0 || ambiguousCostFamilyCount > 0) && (
          <div className="col-span-2 sm:col-span-1">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              Coverage notes
            </p>
            {incompleteCostProviderCount > 0 && (
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                {incompleteCostProviderCount} incomplete cost
                {incompleteCostProviderCount === 1 ? "" : "s"}
              </p>
            )}
            {ambiguousCostFamilyCount > 0 && (
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                {ambiguousCostFamilyCount} multi-key famil
                {ambiguousCostFamilyCount === 1 ? "y" : "ies"} excluded
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
