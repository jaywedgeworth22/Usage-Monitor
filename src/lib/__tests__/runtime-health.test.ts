import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDatabaseFileBaseline,
  getBackupRuntimeStatus,
  getDatabaseFileStatus,
  getDiskRuntimeStatus,
  getRuntimeIdentity,
  getSchedulerReadiness,
  getSchedulerRuntimeStatus,
  getStartupRuntimeStatus,
  markSchedulerStarted,
  markSchedulerTickCompleted,
  markSchedulerTickStarted,
  resetRuntimeHealthForTests,
} from "../runtime-health";

describe("runtime health state", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeHealthForTests();
  });

  it("records scheduler lifecycle without exposing adapter errors", () => {
    const startedAt = new Date("2026-07-11T12:00:00.000Z");
    const tickAt = new Date("2026-07-11T12:01:00.000Z");
    const completedAt = new Date("2026-07-11T12:01:05.000Z");

    markSchedulerStarted(startedAt);
    markSchedulerTickStarted(tickAt);
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      startedAt: startedAt.toISOString(),
      tickInProgress: true,
      lastTickStartedAt: tickAt.toISOString(),
    });

    const unsafeSummary = {
      total: 4,
      successes: 2,
      failures: 1,
      skipped: 1,
      maintenanceHealthy: true,
      providerFetchDegraded: false,
      cloudflareLegacyHandoff: "disabled" as const,
      targetId: "must-not-leak-target-id",
      rawEnv: "must-not-leak-env-value",
      billingPayload: "must-not-leak-billing-payload",
      providerError: "must-not-leak-provider-error",
    };
    markSchedulerTickCompleted(
      true,
      unsafeSummary,
      completedAt
    );
    const runtime = getSchedulerRuntimeStatus();
    expect(runtime).toMatchObject({
      tickInProgress: false,
      lastTickCompletedAt: completedAt.toISOString(),
      lastTickSucceeded: true,
      consecutiveFailures: 0,
      firstFailureAt: null,
      consecutiveProviderFetchDegradedTicks: 0,
      firstProviderFetchDegradedAt: null,
      lastRun: {
        total: 4,
        successes: 2,
        failures: 1,
        skipped: 1,
        maintenanceHealthy: true,
        providerFetchDegraded: false,
        cloudflareLegacyHandoff: "disabled",
      },
    });
    expect(Object.keys(runtime.lastRun ?? {}).sort()).toEqual(
      [
        "cloudflareLegacyHandoff",
        "failures",
        "maintenanceHealthy",
        "providerFetchDegraded",
        "skipped",
        "successes",
        "total",
      ].sort()
    );
    expect(JSON.stringify(runtime)).not.toContain("must-not-leak");
  });

  it("reports release identity and backup enforcement from non-secret env", () => {
    vi.stubEnv("RENDER_SERVICE_NAME", "usage-prod");
    vi.stubEnv("RENDER_GIT_COMMIT", "abc123");
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");

    expect(getRuntimeIdentity()).toMatchObject({
      service: "usage-prod",
      revision: "abc123",
    });
    expect(getBackupRuntimeStatus()).toEqual({
      required: true,
      active: true,
      envOnly: true,
      replicaOk: null,
      replicaAgeSeconds: null,
      // An env-only claim is never proof the replica is advancing, so the
      // side-channel is mandatory unless explicitly opted out.
      verificationRequired: true,
      reason: "env_active_unverified",
    });
    // LITESTREAM_REQUIRED=true also makes the verified startup wrapper
    // mandatory, regardless of hosting platform.
    expect(getStartupRuntimeStatus()).toEqual({
      required: true,
      active: false,
      entrypoint: null,
    });
  });

  it("requires the startup wrapper in production mode and on Litestream-required hosts", () => {
    // Plain test/dev mode without Litestream: not required.
    expect(getStartupRuntimeStatus()).toEqual({
      required: false,
      active: false,
      entrypoint: null,
    });

    // Production mode requires the wrapper so a bare `npm start` fails strict
    // readiness instead of silently skipping backup/migration/Litestream.
    vi.stubEnv("NODE_ENV", "production");
    expect(getStartupRuntimeStatus().required).toBe(true);

    // Explicit opt-out for disposable throwaway containers.
    vi.stubEnv("STARTUP_WRAPPER_REQUIRED", "false");
    expect(getStartupRuntimeStatus().required).toBe(false);
    vi.unstubAllEnvs();

    // Litestream-required hosts need the wrapper in any NODE_ENV.
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    expect(getStartupRuntimeStatus().required).toBe(true);

    // The wrapper marks itself via APP_STARTUP_WRAPPER.
    vi.stubEnv("APP_STARTUP_WRAPPER", "start-with-litestream-v2");
    expect(getStartupRuntimeStatus()).toEqual({
      required: true,
      active: true,
      entrypoint: "start-with-litestream-v2",
    });
  });

  it("reports steady-state disk headroom against the warn threshold", () => {
    const status = getDiskRuntimeStatus();
    expect(status).toMatchObject({
      ok: true,
      thresholdBytes: 5 * 1024 * 1024 * 1024,
      reason: null,
    });
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.totalBytes).toBeGreaterThan(0);

    // DATABASE_URL's directory wins over the cwd fallback.
    vi.stubEnv("DATABASE_URL", "file:./dev.db");
    expect(getDiskRuntimeStatus().ok).toBe(true);

    // A warn threshold above current free space flips only this check.
    vi.stubEnv("READY_DISK_WARN_FREE_BYTES", "1000000000000000000");
    expect(getDiskRuntimeStatus()).toMatchObject({
      ok: false,
      reason: "free_bytes_below_warn_threshold",
      thresholdBytes: 1e18,
    });
    vi.unstubAllEnvs();

    // An unreadable database directory degrades the check, never throws.
    vi.stubEnv("DATABASE_URL", "file:/nonexistent-usage-monitor-dir/prod.db");
    expect(getDiskRuntimeStatus()).toMatchObject({
      ok: false,
      freeBytes: null,
      totalBytes: null,
      reason: "disk_stat_failed",
    });
  });

  it("treats missing replica side-channel as unhealthy when configured (C4)", () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");
    vi.stubEnv(
      "LITESTREAM_REPLICA_STATUS_PATH",
      "/tmp/usage-monitor-missing-replica-status.json"
    );

    expect(getBackupRuntimeStatus()).toMatchObject({
      required: true,
      active: true,
      envOnly: false,
      replicaOk: false,
      verificationRequired: true,
      reason: "replica_status_missing",
    });
  });

  it("allows an explicit opt-out from replica verification", () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");
    vi.stubEnv("LITESTREAM_REPLICA_VERIFICATION_REQUIRED", "false");

    expect(getBackupRuntimeStatus()).toMatchObject({
      envOnly: true,
      replicaOk: null,
      verificationRequired: false,
      reason: "env_active_unverified",
    });
  });


  it("tolerates one transient failure but fails repeated, stalled, and stale ticks", () => {
    vi.stubEnv("SCHEDULER_STALE_AFTER_MS", "1000");
    const now = new Date("2026-07-11T12:10:00.000Z");
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
    markSchedulerTickStarted(new Date("2026-07-11T12:09:58.000Z"));
    expect(getSchedulerReadiness(now).reason).toBe("tick_stalled");

    resetRuntimeHealthForTests();
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
    markSchedulerTickCompleted(false, null, new Date("2026-07-11T12:09:59.500Z"));
    expect(getSchedulerReadiness(now)).toMatchObject({ ok: true, reason: null });
    markSchedulerTickCompleted(false, null, new Date("2026-07-11T12:09:59.600Z"));
    markSchedulerTickCompleted(false, null, new Date("2026-07-11T12:09:59.700Z"));
    expect(getSchedulerReadiness(now).reason).toBe("repeated_tick_failures");
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveFailures: 3,
      firstFailureAt: "2026-07-11T12:09:59.500Z",
    });

    markSchedulerTickCompleted(true, null, new Date("2026-07-11T12:09:59.800Z"));
    expect(getSchedulerReadiness(now)).toMatchObject({ ok: true, reason: null });
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveFailures: 0,
      firstFailureAt: null,
    });

    resetRuntimeHealthForTests();
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
    markSchedulerTickCompleted(true, null, new Date("2026-07-11T12:09:58.000Z"));
    expect(getSchedulerReadiness(now).reason).toBe("tick_stale");
  });

  it("supports an explicit consecutive-failure threshold", () => {
    vi.stubEnv("SCHEDULER_FAILURE_THRESHOLD", "2");
    markSchedulerStarted();
    markSchedulerTickCompleted(false, null);
    expect(getSchedulerReadiness()).toMatchObject({ ok: true, failureThreshold: 2 });
    markSchedulerTickCompleted(false, null);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: false,
      reason: "repeated_tick_failures",
      failureThreshold: 2,
    });
  });

  it("surfaces provider-fetch degradation as a distinct signal only after sustained consecutive ticks, and resets on recovery", () => {
    markSchedulerStarted();
    const degradedRun = {
      total: 6,
      successes: 1,
      failures: 5,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    const healthyRun = {
      ...degradedRun,
      successes: 6,
      failures: 0,
      providerFetchDegraded: false,
    };
    const skippedOnlyRun = {
      ...degradedRun,
      successes: 0,
      failures: 0,
      skipped: 6,
      providerFetchDegraded: false,
    };

    // A single degraded tick must not flip readiness - only a sustained run
    // does. `succeeded` here stays true throughout: provider-fetch health is
    // deliberately independent of maintenanceHealthy/lastTickSucceeded.
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({ ok: true, reason: null });
    expect(
      getSchedulerRuntimeStatus().consecutiveProviderFetchDegradedTicks
    ).toBe(1);

    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({ ok: true, reason: null });

    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: "provider_fetch_degraded",
      providerFetchDegraded: true,
      providerFetchDegradedTickThreshold: 3,
    });
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveProviderFetchDegradedTicks: 3,
      // Never affects lastTickSucceeded/consecutiveFailures - the app itself
      // is still serving; a provider-fetch outage is upstream.
      lastTickSucceeded: true,
      consecutiveFailures: 0,
    });

    // A tick where nothing was attempted (all interval-gated skips) is not
    // degraded and resets the streak.
    markSchedulerTickCompleted(true, skippedOnlyRun);
    expect(
      getSchedulerRuntimeStatus().consecutiveProviderFetchDegradedTicks
    ).toBe(0);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: null,
      providerFetchDegraded: false,
    });

    // Recovery: run the streak back up, then one healthy tick resets it.
    markSchedulerTickCompleted(true, degradedRun);
    markSchedulerTickCompleted(true, degradedRun);
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness().reason).toBe("provider_fetch_degraded");
    markSchedulerTickCompleted(true, healthyRun);
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveProviderFetchDegradedTicks: 0,
      firstProviderFetchDegradedAt: null,
    });
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: null,
      providerFetchDegraded: false,
    });
  });

  it("supports an explicit provider-fetch-degraded consecutive tick threshold", () => {
    vi.stubEnv("PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD", "2");
    markSchedulerStarted();
    const degradedRun = {
      total: 2,
      successes: 0,
      failures: 2,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: null,
      providerFetchDegradedTickThreshold: 2,
    });
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: "provider_fetch_degraded",
      providerFetchDegradedTickThreshold: 2,
    });
  });
});
