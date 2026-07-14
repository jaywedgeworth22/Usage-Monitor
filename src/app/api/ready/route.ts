import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getBackupRuntimeStatus,
  getRuntimeIdentity,
  getSchedulerReadiness,
  getSchedulerRuntimeStatus,
  getStartupRuntimeStatus,
} from "@/lib/runtime-health";

export const dynamic = "force-dynamic";

const DATABASE_TIMEOUT_MS = 2_000;

// Prisma does not cancel the underlying SQLite query when Promise.race's
// timeout wins. Reusing one outstanding probe prevents repeated readiness
// requests from queueing another query every few seconds while SQLite is busy.
// The tracked promise always resolves, so a late database failure cannot become
// an unhandled rejection after the HTTP request has already returned 503.
let databaseProbeInFlight: Promise<boolean> | null = null;

function databaseProbe(): Promise<boolean> {
  if (databaseProbeInFlight) return databaseProbeInFlight;

  const query = Promise.resolve()
    .then(() =>
      prisma.$queryRawUnsafe<Array<Record<string, number>>>("SELECT 1")
    )
    .then(
      () => true,
      () => false
    );
  let tracked: Promise<boolean>;
  tracked = query.finally(() => {
    if (databaseProbeInFlight === tracked) databaseProbeInFlight = null;
  });
  databaseProbeInFlight = tracked;
  return tracked;
}

async function checkDatabase(): Promise<{
  ok: boolean;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const ok = await Promise.race([
      databaseProbe(),
      new Promise<false>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          DATABASE_TIMEOUT_MS
        );
        timeout.unref?.();
      }),
    ]);
    return { ok, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const [database, scheduler, backup, startup] = await Promise.all([
    checkDatabase(),
    Promise.resolve(getSchedulerRuntimeStatus()),
    Promise.resolve(getBackupRuntimeStatus()),
    Promise.resolve(getStartupRuntimeStatus()),
  ]);
  const schedulerReadiness = getSchedulerReadiness();
  const schedulerReady = schedulerReadiness.ok;
  const backupReady = !backup.required || backup.active;
  const startupReady = !startup.required || startup.active;
  const ok = database.ok && schedulerReady && backupReady && startupReady;

  return NextResponse.json(
    {
      ok,
      status: ok ? "ready" : "not_ready",
      ...getRuntimeIdentity(),
      checkedAt: new Date().toISOString(),
      checks: {
        database,
        scheduler: {
          ok: schedulerReady,
          readinessReason: schedulerReadiness.reason,
          staleAfterMs: schedulerReadiness.staleAfterMs,
          failureThreshold: schedulerReadiness.failureThreshold,
          ...scheduler,
        },
        backup: {
          ok: backupReady,
          ...backup,
        },
        startup: {
          ok: startupReady,
          ...startup,
        },
      },
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
