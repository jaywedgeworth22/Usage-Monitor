import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";
import { prisma } from "@/lib/prisma";
import { projectQuotaWindows } from "@/lib/quota-windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/quota-windows
 *
 * Latest remaining-percent quota windows for BotFleet skip-model routing.
 * Dual-auth: dashboard session cookie or USAGE_READ_TOKEN.
 *
 * Response fields are ADDITIVE ONLY -- the iOS app and BotFleet both read
 * `windows` and `skipModelTypes` and must keep working unchanged.  `windows[]`
 * gained `providerKey`, `providerLabel` and `via`, and the body gained
 * `providerGroups` (one entry per provider, including the expected providers
 * that have reported nothing yet).  Nothing was removed or renamed.
 */
export async function GET(request: NextRequest) {
  const hasDashboardSession = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );

  if (!hasDashboardSession) {
    if (!resolveUsageReadToken()) {
      return NextResponse.json(
        { error: "Quota windows are not configured (set USAGE_READ_TOKEN in production)" },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const since = new Date(Date.now() - 14 * 86_400_000);
  const events = await prisma.externalUsageEvent.findMany({
    where: {
      metricType: "quota",
      occurredAt: { gte: since },
    },
    orderBy: { occurredAt: "desc" },
    take: 400,
    select: {
      provider: true,
      service: true,
      label: true,
      credits: true,
      limit: true,
      occurredAt: true,
      metadata: true,
    },
  });

  // Every subscription provider posts `metricType: "quota"` with credits =
  // percent remaining, so no per-provider filter is needed here.
  const projected = projectQuotaWindows(events);
  const body = { ok: true as const, ...projected };
  return NextResponse.json(body, {
    headers: {
      "cache-control": "no-store",
      "x-api-version": "1",
    },
  });
}
