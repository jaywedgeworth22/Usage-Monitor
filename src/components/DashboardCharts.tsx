"use client";

import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useTheme } from "next-themes";
import { formatCurrency } from "@/lib/format";
import SpendBurnChart, { SPEND_BURN_ACCENT } from "@/components/SpendBurnChart";

export interface ChartFamilySlice {
  displayName: string;
  projectedEomUsd: number | null;
  exact?: boolean;
}

export interface FamilyBreakdownSlice {
  name: string;
  value: number;
}

export function shapeFamilyProjectedBreakdown(
  families: ChartFamilySlice[] | undefined | null
): { slices: FamilyBreakdownSlice[]; excludedIncomplete: number } {
  const rows = families ?? [];
  let excludedIncomplete = 0;
  const slices: FamilyBreakdownSlice[] = [];
  for (const p of rows) {
    if (p.exact === false || p.projectedEomUsd == null || p.projectedEomUsd <= 0) {
      if (p.exact === false || p.projectedEomUsd == null) excludedIncomplete += 1;
      continue;
    }
    slices.push({ name: p.displayName, value: p.projectedEomUsd });
  }
  slices.sort((a, b) => b.value - a.value);
  return { slices, excludedIncomplete };
}

interface DashboardChartsProps {
  families?: ChartFamilySlice[];
  /** @deprecated use families */
  providers?: ChartFamilySlice[];
  spentUsd?: number;
  projectedEomUsd?: number;
  monthlyBudgetUsd?: number | null;
}

const COLORS = [
  SPEND_BURN_ACCENT,
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f59e0b",
  "#ef4444",
  "#10b981",
  "#6366f1",
];

export default function DashboardCharts({
  families,
  providers,
  spentUsd,
  projectedEomUsd,
  monthlyBudgetUsd,
}: DashboardChartsProps) {
  const { resolvedTheme } = useTheme();
  const { slices, excludedIncomplete } = useMemo(
    () => shapeFamilyProjectedBreakdown(families ?? providers),
    [families, providers]
  );

  return (
    <div className="space-y-6">
      <SpendBurnChart
        spentUsd={spentUsd}
        projectedEomUsd={projectedEomUsd}
        monthlyBudgetUsd={monthlyBudgetUsd}
      />

      {slices.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Projected cost breakdown
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Exact family projections only
            {excludedIncomplete > 0
              ? ` · ${excludedIncomplete} incomplete/ambiguous excluded`
              : ""}
          </p>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} debounce={50}>
              <PieChart>
                <Pie
                  data={slices}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={78}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="name"
                >
                  {slices.map((entry, index) => (
                    <Cell
                      key={`${entry.name}-${index}`}
                      fill={COLORS[index % COLORS.length]}
                      stroke={resolvedTheme === "dark" ? "#1f2937" : "#ffffff"}
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => formatCurrency(Number(value))}
                  contentStyle={{
                    backgroundColor: resolvedTheme === "dark" ? "#1f2937" : "#ffffff",
                    borderColor: resolvedTheme === "dark" ? "#374151" : "#e5e7eb",
                    color: resolvedTheme === "dark" ? "#f3f4f6" : "#111827",
                    borderRadius: "0.5rem",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: "13px" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
