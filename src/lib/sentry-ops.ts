// Sparse, trace-attached Sentry ops for THIS app.
//
// Token/cost time series stay in Usage Monitor.  Application Metrics shipped
// in Sentry in 2026, so app-health counters (`scheduler.tick`, `ingest.failed`)
// may emit there and jump to the enclosing trace.  Structured logs are the
// same split: Datadog remains the warehouse; Sentry.logger is a few health
// outcomes, not the access-log firehose.  Every call is a no-op when the SDK
// was never initialized (no DSN).

export const SENTRY_CRON_MONITOR_SLUG = "usage-monitor-scheduler";

// Must match POLL_INTERVAL_MS in usage-recorder.ts (15 minutes).  The 2026-08-31
// expansion upserted this monitor as 1 minute + 5 minute margin, so a healthy
// 15-minute tick looked like a missed check-in.  Do not change the job cadence
// to appease Sentry — change the monitor to match the job.
export const SENTRY_CRON_INTERVAL_MINUTES = 15;
export const SENTRY_CRON_CHECKIN_MARGIN = 5;
export const SENTRY_CRON_MAX_RUNTIME = 10;

export function sentryCronMonitorConfig(): {
  schedule: { type: "interval"; value: number; unit: "minute" };
  checkinMargin: number;
  maxRuntime: number;
  timezone: "UTC";
} {
  return {
    schedule: {
      type: "interval",
      value: SENTRY_CRON_INTERVAL_MINUTES,
      unit: "minute",
    },
    checkinMargin: SENTRY_CRON_CHECKIN_MARGIN,
    maxRuntime: SENTRY_CRON_MAX_RUNTIME,
    timezone: "UTC",
  };
}

type SentryMod = typeof import("@sentry/nextjs") & {
  default?: typeof import("@sentry/nextjs");
};

async function loadSentry(): Promise<SentryMod | null> {
  try {
    return (await import("@sentry/nextjs")) as SentryMod;
  } catch {
    return null;
  }
}

function api<T>(mod: SentryMod, key: "captureCheckIn" | "logger" | "metrics"): T | undefined {
  return (mod[key] ?? mod.default?.[key]) as T | undefined;
}

export async function recordSentryCronHeartbeat(
  status: "ok" | "error"
): Promise<void> {
  try {
    const mod = await loadSentry();
    const captureCheckIn = mod
      ? api<typeof import("@sentry/nextjs").captureCheckIn>(mod, "captureCheckIn")
      : undefined;
    if (typeof captureCheckIn !== "function") return;
    captureCheckIn(
      { monitorSlug: SENTRY_CRON_MONITOR_SLUG, status },
      sentryCronMonitorConfig()
    );
  } catch {
    // Sentry cron check-in is best-effort and non-fatal.
  }
}

export async function logSchedulerOutcome(
  status: "ok" | "error" | "disabled",
  attributes: Record<string, string | number | boolean | undefined> = {}
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const logger = api<{
      warn: (message: string, attrs?: Record<string, unknown>) => void;
      error: (message: string, attrs?: Record<string, unknown>) => void;
    }>(mod, "logger");
    const metrics = api<{
      count: (
        name: string,
        value?: number,
        options?: { attributes?: Record<string, string | number | boolean> }
      ) => void;
    }>(mod, "metrics");
    const attrs = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean>;
    if (status === "ok") {
      metrics?.count?.("scheduler.tick", 1, {
        attributes: { outcome: "ok", ...attrs },
      });
      return;
    }
    if (status === "disabled") {
      logger?.warn?.("scheduler.disabled", attrs);
      metrics?.count?.("scheduler.tick", 1, {
        attributes: { outcome: "disabled", ...attrs },
      });
      return;
    }
    logger?.error?.("scheduler.tick_failed", attrs);
    metrics?.count?.("scheduler.tick", 1, {
      attributes: { outcome: "error", ...attrs },
    });
  } catch {
    // Sparse Sentry logs/metrics are best-effort.
  }
}

export async function logSchedulerDegraded(
  attributes: Record<string, string | number | boolean | undefined>
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const logger = api<{
      warn: (message: string, attrs?: Record<string, unknown>) => void;
    }>(mod, "logger");
    const attrs = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean>;
    logger?.warn?.("scheduler.provider_fetch_degraded", attrs);
  } catch {
    // Sparse Sentry logs are best-effort.
  }
}

export async function logIngestFailed(
  attributes: Record<string, string | number | boolean | undefined>
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const logger = api<{
      warn: (message: string, attrs?: Record<string, unknown>) => void;
    }>(mod, "logger");
    const metrics = api<{
      count: (
        name: string,
        value?: number,
        options?: { attributes?: Record<string, string | number | boolean> }
      ) => void;
    }>(mod, "metrics");
    const attrs = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean>;
    logger?.warn?.("ingest.failed", attrs);
    metrics?.count?.("ingest.failed", 1, { attributes: attrs });
  } catch {
    // Sparse Sentry logs/metrics are best-effort.
  }
}
