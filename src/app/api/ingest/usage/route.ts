import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { persistExternalUsageEvents } from "@/lib/external-usage-events";
import { parseUsageTelemetryBatch } from "@/lib/usage-telemetry";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { isUsageIngestAuthorized } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 10 requests per second per source IP — generous enough for normal
// fire-and-forget telemetry pushes while preventing abuse.
const ingestRateLimiter = createRateLimiter(1_000, 10);

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const ip = getClientIp(request);
  if (!ingestRateLimiter.check(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429 }
    );
  }

  if (!isUsageIngestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let events;
  try {
    events = parseUsageTelemetryBatch(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const persistResult = await persistExternalUsageEvents(
    events.map((event) => ({
      idempotencyKey: event.idempotencyKey,
      sourceApp: event.sourceApp,
      environment: event.environment,
      provider: event.provider,
      service: event.service,
      label: event.label,
      keyRef: event.keyRef,
      billingMode: event.billingMode,
      metricType: event.metricType,
      quantity: event.quantity,
      unit: event.unit,
      costUsd: event.costUsd,
      requests: event.requests,
      credits: event.credits,
      limit: event.limit,
      limitWindow: event.limitWindow,
      tier: event.tier,
      confidence: event.confidence,
      windowStart: event.windowStart,
      windowEnd: event.windowEnd,
      occurredAt: event.occurredAt,
      metadata: event.metadata as Prisma.InputJsonObject | undefined,
    }))
  );

  return NextResponse.json(
    {
      ok: true,
      accepted: persistResult.persisted,
      ignoredPruned: persistResult.skippedPrunedDuplicates,
    },
    { status: 202 }
  );
}
