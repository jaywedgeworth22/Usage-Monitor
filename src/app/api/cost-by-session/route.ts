import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  buildCostBySessionReport,
  loadCostBySessionRows,
  parseSessionIdsParam,
} from "@/lib/cost-by-session";

export const dynamic = "force-dynamic";

/**
 * GET /api/cost-by-session?ids=a,b,c[&since=ISO][&until=ISO]
 *
 * "Cost per board item": given the Claude Code session id(s) THE BOARD
 * (mac-collab) recorded on a finding via `board claim/status/comment
 * --session`, sums tokens and API-equivalent cost across those sessions from
 * the same ExternalUsageEvent rows the /api/otlp/v1/metrics ingest already
 * writes. See src/lib/cost-by-session.ts for the aggregation and the
 * analytics-only cost caveat.
 *
 * Dashboard-session gated like every other non-ingest route (no middleware
 * exclusion in src/middleware.ts -- same pattern as GET /api/llm-burn).
 *
 * `since`/`until` default to the trailing DEFAULT_WINDOW_DAYS and are capped
 * at MAX_WINDOW_DAYS apart so a stale or typo'd session id can't force a
 * full-table scan; out-of-range or malformed dates 400 rather than silently
 * clamp, matching /api/export/daily-rollups.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const parsedIds = parseSessionIdsParam(searchParams);
  if ("error" in parsedIds) {
    return NextResponse.json({ error: parsedIds.error }, { status: 400 });
  }

  const now = new Date();
  const untilParam = searchParams.get("until");
  const sinceParam = searchParams.get("since");

  const until = untilParam ? new Date(untilParam) : now;
  if (Number.isNaN(until.getTime())) {
    return NextResponse.json({ error: "invalid_until" }, { status: 400 });
  }

  const defaultSince = new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  const since = sinceParam ? new Date(sinceParam) : defaultSince;
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: "invalid_since" }, { status: 400 });
  }
  if (since > until) {
    return NextResponse.json({ error: "since_after_until" }, { status: 400 });
  }
  const windowDays = (until.getTime() - since.getTime()) / 86_400_000;
  if (windowDays > MAX_WINDOW_DAYS) {
    return NextResponse.json(
      { error: `window_too_large (max ${MAX_WINDOW_DAYS} days)` },
      { status: 400 }
    );
  }

  const rows = await loadCostBySessionRows(parsedIds.ids, since, until);
  const report = buildCostBySessionReport(parsedIds.ids, rows);

  return NextResponse.json({
    ...report,
    window: { since: since.toISOString(), until: until.toISOString() },
  });
}
