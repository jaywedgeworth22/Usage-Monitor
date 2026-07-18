export function isUsageSchedulerEnabled(
  configured = process.env.USAGE_SCHEDULER_ENABLED
): boolean {
  return configured?.trim().toLowerCase() !== "false";
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Bound native (non-heap) SQLite memory before any request or scheduler
  // tick can issue a query. Next.js guarantees register() completes before
  // the server accepts a request, so this ordering is safe without an
  // explicit lock. Applied unconditionally - HTTP requests use Prisma even
  // when the polling scheduler below is emergency-disabled. See the
  // comment on applySqliteNativeMemoryPragmas in src/lib/prisma.ts.
  const { applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");
  await applySqliteNativeMemoryPragmas();

  // Warm the budget-status SWR cache in the background so the dashboard's
  // first request after a deploy doesn't have to eat the cold ~11s
  // computeBudgetStatus recompute itself (see the cache in
  // @/lib/budget-status). Deliberately NOT awaited - a slow or erroring DB
  // at boot must not delay/block server readiness; if this hasn't finished
  // by the time the first request lands, that request just computes inline
  // as it always did before this cache existed.
  const { computeBudgetStatus } = await import("@/lib/budget-status");
  computeBudgetStatus().catch((error) => {
    console.warn("[budget-status-cache] boot warm-up failed", error);
  });

  if (!isUsageSchedulerEnabled()) {
    console.warn(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
    return;
  }
  const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
  startUsagePollingScheduler();
}
