import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CongressInfrastructureCard,
  CoolifyFleetCard,
  FleetBackupsCard,
  markOperationsStale,
  ReceiptInboxCard,
  R2FleetCard,
  SocraticInfrastructureCard,
} from "@/components/OperationsOverview";

describe("OperationsOverview cards", () => {
  it("keeps receipt evidence separate from money and labels unconfigured state", () => {
    const html = renderToStaticMarkup(createElement(ReceiptInboxCard, {
      data: {
        configured: false,
        state: "unconfigured",
        needsReviewCount: 0,
        countIsLowerBound: false,
        latestReceivedAt: null,
        fetchedAt: "2026-07-18T10:00:00.000Z",
        items: [],
      },
    }));
    expect(html).toContain("Receipt inbox");
    expect(html).toContain("Not configured");
    expect(html).toContain("review before any cost is recorded");
    expect(html).toContain("matches existing cash");
    expect(html).toContain("not double-count");
    expect(html).not.toContain("$0");
  });

  it("shows unavailable infrastructure values without fabricating zero metrics", () => {
    const html = renderToStaticMarkup(createElement(SocraticInfrastructureCard, {
      data: {
        state: "unreachable",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        releaseSha: null,
        processStartedAt: null,
        processUptimeSeconds: null,
        recentRestart: false,
        database: "unknown",
        schedulerAgeSeconds: null,
        schedulerStale: false,
        activeTradingAccounts: null,
        degradedTradingAccounts: null,
        tradingLivenessDegraded: false,
        marketOpen: null,
        dataProvidersDegraded: false,
        dependencyCount: null,
        failedDependencies: [],
        pineconeConfigured: null,
        ragEmbedProvider: null,
        openrouterCreditsOk: null,
        openrouterCreditsThresholdUsd: null,
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: null,
        litestreamAgeSeconds: null,
        storageDegraded: false,
        adminUrl: "https://admin.socratictrade.com/admin/server",
      },
    }));
    expect(html).toContain("Socratic Trade infrastructure");
    expect(html).toContain("Unreachable");
    expect(html).toContain("scheduler unavailable");
    expect(html).toContain("uptime unknown");
    expect(html).not.toContain("0 GB");
    expect(html).not.toContain("0%");
  });

  it("shows Congress.Trade liveness without fabricating pipeline as degraded", () => {
    const html = renderToStaticMarkup(createElement(CongressInfrastructureCard, {
      data: {
        state: "healthy",
        fetchedAt: "2026-08-20T03:00:00.000Z",
        ok: true,
        database: "ok",
        schemaOk: true,
        pipelineStatus: "degraded",
        releaseSha: "abcdef123456",
        failedChecks: [],
        adminUrl: "https://congress.trade/api/health",
      },
    }));
    expect(html).toContain("Congress.Trade Liveness");
    expect(html).toContain("Healthy");
    expect(html).toContain("pipeline degraded");
    expect(html).toContain("last-resort lanes excluded");
  });

  it("surfaces recent restart and Coolify fleet app rows", () => {
    const stHtml = renderToStaticMarkup(createElement(SocraticInfrastructureCard, {
      data: {
        state: "degraded",
        fetchedAt: "2026-08-10T23:50:00.000Z",
        releaseSha: "06d50e9950c27a9b918a322176f21f3dacb7e0e6",
        processStartedAt: "2026-08-10T23:47:25.801Z",
        processUptimeSeconds: 120,
        recentRestart: true,
        database: "ok",
        schedulerAgeSeconds: 12,
        schedulerStale: false,
        activeTradingAccounts: 3,
        degradedTradingAccounts: 3,
        tradingLivenessDegraded: true,
        marketOpen: false,
        dataProvidersDegraded: true,
        dependencyCount: 21,
        failedDependencies: [],
        pineconeConfigured: true,
        ragEmbedProvider: "openrouter",
        openrouterCreditsOk: true,
        openrouterCreditsThresholdUsd: 3,
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: "replicating",
        litestreamAgeSeconds: 40,
        storageDegraded: false,
        adminUrl: "https://admin.socratictrade.com/admin/server",
      },
    }));
    expect(stHtml).toContain("recent restart");
    expect(stHtml).toContain("trading liveness degraded");
    expect(stHtml).toContain("data providers degraded");

    const fleetHtml = renderToStaticMarkup(createElement(CoolifyFleetCard, {
      data: {
        configured: true,
        state: "healthy",
        host: "https://host.jays.services",
        applications: [
          {
            name: "socratic-app",
            type: "application",
            status: "running:healthy",
            state: "running",
            health: "healthy",
            up: true,
            degraded: false,
            fqdn: "https://socratictrade.com",
          },
        ],
        resources: [
          {
            name: "socratic-app",
            type: "application",
            status: "running:healthy",
            state: "running",
            health: "healthy",
            up: true,
            degraded: false,
            fqdn: null,
          },
          {
            name: "usage-monitor",
            type: "application",
            status: "running:healthy",
            state: "running",
            health: "healthy",
            up: true,
            degraded: false,
            fqdn: null,
          },
        ],
        appsUp: 1,
        appsDown: 0,
        appsDegraded: 0,
        appsUnknown: 0,
        fetchedAt: "2026-08-10T23:50:00.000Z",
      },
    }));
    expect(fleetHtml).toContain("Coolify fleet");
    expect(fleetHtml).toContain("1 up");
    expect(fleetHtml).toContain("host.jays.services");
  });

  it("marks both previously healthy cards stale when the dashboard refresh fails", () => {
    const stale = markOperationsStale({
      fetchedAt: "2026-07-18T10:00:00.000Z",
      receiptInbox: {
        configured: true,
        state: "receiving",
        needsReviewCount: 1,
        countIsLowerBound: false,
        latestReceivedAt: "2026-07-18T09:00:00.000Z",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        items: [],
      },
      socraticInfrastructure: {
        state: "healthy",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        releaseSha: null,
        processStartedAt: null,
        processUptimeSeconds: 3600,
        recentRestart: false,
        database: "ok",
        schedulerAgeSeconds: 10,
        schedulerStale: false,
        activeTradingAccounts: 1,
        degradedTradingAccounts: 0,
        tradingLivenessDegraded: false,
        marketOpen: true,
        dataProvidersDegraded: false,
        dependencyCount: 5,
        failedDependencies: [],
        pineconeConfigured: true,
        ragEmbedProvider: "openrouter",
        openrouterCreditsOk: true,
        openrouterCreditsThresholdUsd: 3,
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: "replicating",
        litestreamAgeSeconds: 10,
        storageDegraded: false,
        adminUrl: "https://admin.socratictrade.com/admin/server",
      },
      congressInfrastructure: {
        state: "healthy",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        ok: true,
        database: "ok",
        schemaOk: true,
        pipelineStatus: "ok",
        releaseSha: "abcdef12",
        failedChecks: [],
        adminUrl: "https://congress.trade/api/health",
      },
      coolifyFleet: {
        configured: true,
        state: "healthy",
        host: "https://host.jays.services",
        applications: [],
        resources: [],
        appsUp: 0,
        appsDown: 0,
        appsDegraded: 0,
        appsUnknown: 0,
        fetchedAt: "2026-07-18T10:00:00.000Z",
      },
      r2Fleet: {
        configured: false,
        thresholdPct: 70,
        freeTier: { storageBytes: 10 * 1024 ** 3, classAOps: 1_000_000, classBOps: 10_000_000 },
        accounts: [],
        anyOnTrackToExceed: false,
        fetchedAt: "2026-07-18T10:00:00.000Z",
        localBackup: { autoDisabled: false, litestreamUsesR2: true },
      },
      fleetBackups: {
        configured: true,
        ok: true,
        asOf: "2026-07-18T10:00:00.000Z",
        cacheAgeSeconds: 0,
        apps: [
          {
            id: "usage-monitor",
            label: "Usage Monitor",
            self: true,
            ok: true,
            locations: [
              {
                id: "b2-full-dump",
                label: "B2 Full Dump",
                ok: true,
                present: true,
                latestAgeSeconds: 120,
                bytes: 1_000_000,
                fileCount: 2,
                reason: null,
              },
            ],
          },
        ],
        warnings: [],
      },
    });
    expect(stale.receiptInbox.state).toBe("stale");
    expect(stale.socraticInfrastructure.state).toBe("stale");
    expect(stale.congressInfrastructure.state).toBe("stale");
    expect(stale.coolifyFleet.state).toBe("stale");
    expect(stale.receiptInbox.error).toBe("dashboard_refresh_failed");
    expect(stale.r2Fleet?.configured).toBe(false);
    expect(stale.fleetBackups?.ok).toBe(false);
  });

  it("renders the fleet R2 card for three apps", () => {
    const html = renderToStaticMarkup(createElement(R2FleetCard, {
      data: {
        configured: true,
        thresholdPct: 70,
        freeTier: { storageBytes: 10 * 1024 ** 3, classAOps: 1_000_000, classBOps: 10_000_000 },
        anyOnTrackToExceed: false,
        fetchedAt: "2026-08-05T12:00:00.000Z",
        localBackup: { autoDisabled: false, litestreamUsesR2: true },
        accounts: [
          {
            id: "um",
            label: "Usage Monitor",
            accountIdSuffix: "12345678",
            configured: true,
            status: "ok",
            storage: { actual: 1e9, limit: 10e9, mtdPct: 10, projected: 1e9, projectedPct: 10, onTrackToExceed: false },
            classA: { actual: 1000, limit: 1e6, mtdPct: 0.1, projected: 2000, projectedPct: 0.2, onTrackToExceed: false },
            classB: { actual: 5000, limit: 1e7, mtdPct: 0.05, projected: 10000, projectedPct: 0.1, onTrackToExceed: false },
            overallOnTrackToExceed70Pct: false,
            metricsSource: "cloudflare_graphql",
            buckets: [{ bucketName: "usage-monitor-prod-v3", bytes: 1e9 }],
          },
          {
            id: "st",
            label: "Socratic Trade",
            accountIdSuffix: null,
            configured: false,
            status: "unconfigured",
            storage: null,
            classA: null,
            classB: null,
            overallOnTrackToExceed70Pct: false,
            metricsSource: "unconfigured",
            buckets: [],
          },
          {
            id: "ct",
            label: "Congress.Trade",
            accountIdSuffix: null,
            configured: false,
            status: "unconfigured",
            storage: null,
            classA: null,
            classB: null,
            overallOnTrackToExceed70Pct: false,
            metricsSource: "unconfigured",
            buckets: [],
          },
        ],
      },
    }));
    expect(html).toContain("R2 free tier (fleet)");
    expect(html).toContain("Usage Monitor");
    expect(html).toContain("Socratic Trade");
    expect(html).toContain("Congress.Trade");
    expect(html).toContain("usage-monitor-prod-v3");
    expect(html).toContain("Status:");
    expect(html).toContain("Class A ops");
    expect(html).toContain("Class B ops");
    expect(html).toContain("Top buckets");
  });

  it("renders Jay Old as R2 not enabled instead of leftover storage", () => {
    const html = renderToStaticMarkup(createElement(R2FleetCard, {
      data: {
        configured: true,
        thresholdPct: 70,
        freeTier: { storageBytes: 10 * 1024 ** 3, classAOps: 1_000_000, classBOps: 10_000_000 },
        anyOnTrackToExceed: false,
        fetchedAt: "2026-08-15T12:00:00.000Z",
        localBackup: { autoDisabled: false, litestreamUsesR2: false },
        accounts: [
          {
            id: "old",
            label: "Jay (Old)",
            accountIdSuffix: "a9608c73",
            configured: true,
            status: "ok",
            storage: null,
            classA: null,
            classB: null,
            overallOnTrackToExceed70Pct: false,
            metricsSource: "r2_not_enabled",
            buckets: [],
          },
        ],
      },
    }));
    expect(html).toContain("Jay (Old)");
    expect(html).toContain("R2 is not enabled on this account.");
    expect(html).not.toContain("116");
    expect(html).not.toContain("Class A ops");
  });
});
