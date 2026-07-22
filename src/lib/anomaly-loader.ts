import { prisma } from "@/lib/prisma";
import {
  type AnomalyConfig,
  type AnomalyResult,
  dailyIncrementsFromCumulative,
  detectSeriesAnomaly,
  resolveAnomalyConfig,
} from "@/lib/anomaly-detection";
import { loadMtdDailyVariableUsageByProviderId } from "@/lib/daily-usage-series";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Hard cap on scanned scalar rows; keeps this memory-light on the hot budget
// path even for high-frequency pollers (only 4 scalar columns are selected —
// never the rawData blob that caused the #392 OOM).
const MAX_SNAPSHOT_ROWS = 20_000;

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface SnapshotScalarRow {
  providerId: string;
  fetchedAt: Date;
  totalCost: number | null;
  totalRequests: number | null;
}

interface DayPeak {
  cost: number | null;
  requests: number | null;
}

/**
 * Build per-provider daily incremental cost & request series from raw poll
 * snapshots and run the detector on the latest day of each.
 *
 * Poll snapshots carry a CUMULATIVE month-to-date `totalCost` / `totalRequests`
 * sampled every refresh interval. We collapse them to one cumulative peak per
 * (provider, UTC day) and difference them into per-day increments (see
 * `dailyIncrementsFromCumulative`, which resets at month boundaries and clamps
 * corrections). The detector then compares the most recent day against a robust
 * baseline of the preceding days.
 *
 * Returns providerId → anomalies (cost and/or requests). Providers with too
 * little history simply produce no entry. Disabled config returns an empty map.
 */
export async function loadSpendAnomaliesByProviderId(
  now: Date = new Date(),
  config: AnomalyConfig = resolveAnomalyConfig(),
  /**
   * Optional already-loaded providers so budget-status does not pay a second
   * `provider.findMany` (cache-dedupe asserts a single call per compute).
   */
  knownProviders?: readonly { id: string; name: string }[]
): Promise<Map<string, AnomalyResult[]>> {
  const results = new Map<string, AnomalyResult[]>();
  if (!config.enabled) return results;

  // +2 days of slack: one so the earliest kept day still has a prior day to
  // diff against, one so "today" (the observed point) sits on a full baseline.
  const windowStart = new Date(now.getTime() - (config.windowDays + 2) * MS_PER_DAY);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const resolvedProviders = knownProviders
    ? [...knownProviders]
    : await prisma.provider.findMany({
        select: { id: true, name: true },
      });

  const [rows, pushDailyByProviderId] = await Promise.all([
    prisma.usageSnapshot.findMany({
      where: { fetchedAt: { gte: windowStart, lte: now } },
      orderBy: { fetchedAt: "desc" },
      take: MAX_SNAPSHOT_ROWS,
      select: {
        providerId: true,
        fetchedAt: true,
        totalCost: true,
        totalRequests: true,
      },
    }) as Promise<SnapshotScalarRow[]>,
    // Wave J / E11: push-primary providers have no useful snapshot series —
    // load MTD variable daily costs from ExternalUsageEvent as a second channel.
    loadMtdDailyVariableUsageByProviderId(monthStart, now, resolvedProviders),
  ]);

  const byProvider = new Map<string, Map<string, DayPeak>>();
  for (const row of rows) {
    const day = utcDayKey(row.fetchedAt);
    let days = byProvider.get(row.providerId);
    if (!days) {
      days = new Map();
      byProvider.set(row.providerId, days);
    }
    const peak = days.get(day) ?? { cost: null, requests: null };
    if (row.totalCost != null) peak.cost = Math.max(peak.cost ?? row.totalCost, row.totalCost);
    if (row.totalRequests != null) {
      peak.requests = Math.max(peak.requests ?? row.totalRequests, row.totalRequests);
    }
    days.set(day, peak);
  }

  for (const [providerId, days] of byProvider) {
    const dayKeys = [...days.keys()].sort();
    const anomalies: AnomalyResult[] = [];

    const costCumulative = dayKeys
      .filter((day) => days.get(day)?.cost != null)
      .map((day) => ({ day, cumulative: days.get(day)!.cost as number }));
    if (costCumulative.length >= 2) {
      const anomaly = detectSeriesAnomaly(
        dailyIncrementsFromCumulative(costCumulative),
        "cost",
        config
      );
      if (anomaly) anomalies.push({ ...anomaly, providerId });
    }

    const reqCumulative = dayKeys
      .filter((day) => days.get(day)?.requests != null)
      .map((day) => ({ day, cumulative: days.get(day)!.requests as number }));
    if (reqCumulative.length >= 2) {
      const anomaly = detectSeriesAnomaly(
        dailyIncrementsFromCumulative(reqCumulative),
        "requests",
        config
      );
      if (anomaly) anomalies.push({ ...anomaly, providerId });
    }

    if (anomalies.length > 0) results.set(providerId, anomalies);
  }

  // Push channel: attach cost anomalies for providers that only (or also)
  // report via ExternalUsageEvent. Skip when snapshot already produced a cost
  // anomaly for that provider id so we do not double-notify. Do not prefilter
  // on "two positive days" — zero-baseline first-spike is a valid detector path.
  for (const [providerId, daily] of pushDailyByProviderId) {
    if (daily.length < 2) continue;
    const series = daily.map((value, i) => ({
      day: new Date(monthStart.getTime() + i * MS_PER_DAY)
        .toISOString()
        .slice(0, 10),
      value,
    }));
    const anomaly = detectSeriesAnomaly(series, "cost", config);
    if (!anomaly) continue;
    const existing = results.get(providerId) ?? [];
    if (existing.some((a) => a.metric === "cost")) continue;
    existing.push({ ...anomaly, providerId });
    results.set(providerId, existing);
  }

  return results;
}
