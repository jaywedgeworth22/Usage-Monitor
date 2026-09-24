// Agent model mix: a fleet-wide (all sourceApps, not one producer) rollup of
// token/cost/event volume grouped by sourceApp x provider x model x seat x
// project over a trailing window.  Built for the weekly "fleet-mode
// compliance digest" script (a sibling repo) to poll — it wants a coarse
// answer to "which agents ran which models, how much, and (once seat
// attribution lands) which seat" without reimplementing the aggregate query.
//
// Split follows the external-usage-events.ts loadAnalyticsTokenRows /
// deriveAnalyticsTokenUsdByProvider convention: one bounded
// prisma.$queryRaw + Prisma.sql aggregate (loadAgentModelMixRows) and one
// PURE reducer (buildAgentModelMixReport) that never calls `new Date()` — the
// caller supplies windowStart/windowEnd/generatedAt so unit tests use plain
// literal Date fixtures with no vi.useFakeTimers() needed (see local memory
// note "wall-clock test rot").
//
// Cost/token figures here are the same class of number as llm-burn.ts and
// claude-cost-check.ts: analytics-only, API-equivalent estimates (recorded
// costUsd where a producer sent one; summed raw token quantity otherwise).
// They are NOT authoritative cash — cash spend is budget-status.ts's job.
//
// "seat" is read via json_extract("metadata", '$.seat') for forward
// compatibility, but src/lib/otlp/mapping-utils.ts's METADATA_ALLOWLIST does
// not yet include "seat" (confirmed 2026-09-24), so every row's seat is
// currently null.  seatDataAvailable in the report reflects that honestly
// instead of hiding the gap.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface AgentModelMixRow {
  sourceApp: string;
  provider: string;
  /** ExternalUsageEvent.keyRef — the model identifier field in this schema. */
  model: string | null;
  /** json_extract("metadata", '$.seat'); null until the OTLP allowlist adds "seat". */
  seat: string | null;
  /** json_extract("metadata", '$.project'); the producer-supplied project name. */
  project: string | null;
  tokens: number;
  costUsd: number;
  eventCount: number;
}

/**
 * Fleet-wide aggregate over ExternalUsageEvent for the trailing window —
 * every sourceApp, not filtered to claude-code. One bounded query; grouped
 * in SQL so the row count is bounded by the distinct
 * sourceApp/provider/model/seat/project combinations, not raw event count.
 * Fails closed (empty array) when the Prisma client in tests has no
 * $queryRaw, matching loadAnalyticsTokenRows's contract.
 */
export async function loadAgentModelMixRows(
  windowStart: Date,
  windowEnd: Date
): Promise<AgentModelMixRow[]> {
  if (typeof prisma.$queryRaw !== "function") return [];
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        sourceApp: string;
        provider: string;
        model: string | null;
        seat: string | null;
        project: string | null;
        tokens: unknown;
        costUsd: unknown;
        eventCount: unknown;
      }>
    >(Prisma.sql`
      SELECT
        "sourceApp",
        "provider",
        "keyRef" AS "model",
        json_extract("metadata", '$.seat') AS "seat",
        json_extract("metadata", '$.project') AS "project",
        COALESCE(
          SUM(CASE WHEN "metricType" = 'usage' AND "unit" = 'token' THEN "quantity" ELSE 0 END),
          0
        ) AS "tokens",
        COALESCE(
          SUM(CASE WHEN "metricType" = 'cost' THEN "costUsd" ELSE 0 END),
          0
        ) AS "costUsd",
        COUNT(*) AS "eventCount"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= ${windowStart}
        AND "occurredAt" <= ${windowEnd}
      GROUP BY
        "sourceApp",
        "provider",
        "keyRef",
        json_extract("metadata", '$.seat'),
        json_extract("metadata", '$.project')
    `);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => typeof row?.sourceApp === "string" && typeof row.provider === "string")
      .map((row) => ({
        sourceApp: row.sourceApp,
        provider: row.provider,
        model: row.model ?? null,
        seat: row.seat ?? null,
        project: row.project ?? null,
        tokens: Number(row.tokens ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        eventCount: Number(row.eventCount ?? 0),
      }));
  } catch {
    return [];
  }
}

export interface AgentModelMixReport {
  windowStart: string;
  windowEnd: string;
  days: number;
  generatedAt: string;
  /** True iff at least one aggregated row carries a non-null seat. */
  seatDataAvailable: boolean;
  costSemantics: "estimated_api_equivalent_not_authoritative";
  billingMode: "estimated";
  rows: AgentModelMixRow[];
  totals: {
    tokens: number;
    costUsd: number;
    eventCount: number;
  };
}

/**
 * Pure reducer: shapes loaded rows into the response the digest script
 * consumes. Deliberately takes windowStart/windowEnd/days/generatedAt as
 * parameters instead of calling `new Date()` — see the module docblock.
 * Rows are sorted by tokens desc (then costUsd desc, then
 * sourceApp/provider/model asc) so the biggest fleet consumers sort first
 * and output is deterministic for a fixed input.
 */
export function buildAgentModelMixReport(
  rows: AgentModelMixRow[],
  windowStart: Date,
  windowEnd: Date,
  days: number,
  generatedAt: Date
): AgentModelMixReport {
  const sorted = [...rows].sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    const bySourceApp = a.sourceApp.localeCompare(b.sourceApp);
    if (bySourceApp !== 0) return bySourceApp;
    const byProvider = a.provider.localeCompare(b.provider);
    if (byProvider !== 0) return byProvider;
    return (a.model ?? "").localeCompare(b.model ?? "");
  });

  const totals = sorted.reduce(
    (acc, row) => {
      acc.tokens += row.tokens;
      acc.costUsd += row.costUsd;
      acc.eventCount += row.eventCount;
      return acc;
    },
    { tokens: 0, costUsd: 0, eventCount: 0 }
  );

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    days,
    generatedAt: generatedAt.toISOString(),
    seatDataAvailable: sorted.some((row) => row.seat != null),
    costSemantics: "estimated_api_equivalent_not_authoritative",
    billingMode: "estimated",
    rows: sorted,
    totals,
  };
}
