import { describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "@/lib/usage-recorder";
import {
  SENTRY_CRON_CHECKIN_MARGIN,
  SENTRY_CRON_INTERVAL_MINUTES,
  SENTRY_CRON_MAX_RUNTIME,
  SENTRY_CRON_MONITOR_SLUG,
  sentryCronMonitorConfig,
} from "@/lib/sentry-ops";

describe("sentry cron monitor config", () => {
  it("matches the in-process 15-minute scheduler cadence", () => {
    expect(SENTRY_CRON_MONITOR_SLUG).toBe("usage-monitor-scheduler");
    expect(SENTRY_CRON_INTERVAL_MINUTES).toBe(15);
    expect(POLL_INTERVAL_MS).toBe(SENTRY_CRON_INTERVAL_MINUTES * 60 * 1000);
    const config = sentryCronMonitorConfig();
    expect(config.schedule).toEqual({
      type: "interval",
      value: 15,
      unit: "minute",
    });
    expect(config.checkinMargin).toBe(SENTRY_CRON_CHECKIN_MARGIN);
    expect(config.maxRuntime).toBe(SENTRY_CRON_MAX_RUNTIME);
    expect(config.timezone).toBe("UTC");
  });

  it("does not advertise a 1-minute schedule that would miss healthy ticks", () => {
    expect(sentryCronMonitorConfig().schedule.value).not.toBe(1);
  });
});

describe("sparse Sentry ops no-op without a client", () => {
  it("swallows SDK load failures", async () => {
    vi.resetModules();
    vi.doMock("@sentry/nextjs", () => {
      throw new Error("sdk missing");
    });
    const {
      recordSentryCronHeartbeat,
      logSchedulerOutcome,
      logSchedulerDegraded,
      logIngestFailed,
    } = await import("@/lib/sentry-ops");
    await expect(recordSentryCronHeartbeat("ok")).resolves.toBeUndefined();
    await expect(logSchedulerOutcome("ok")).resolves.toBeUndefined();
    await expect(logSchedulerDegraded({ failures: 1 })).resolves.toBeUndefined();
    await expect(logIngestFailed({ reason: "test" })).resolves.toBeUndefined();
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });
});
