import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markOperationsStale, ReceiptInboxCard, R2FleetCard, SocraticInfrastructureCard } from "@/components/OperationsOverview";

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
    expect(html).toContain("review is required before any cost is recorded");
    expect(html).not.toContain("$0");
  });

  it("shows unavailable infrastructure values without fabricating zero metrics", () => {
    const html = renderToStaticMarkup(createElement(SocraticInfrastructureCard, {
      data: {
        state: "unreachable",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        releaseSha: null,
        database: "unknown",
        schedulerAgeSeconds: null,
        activeTradingAccounts: null,
        degradedTradingAccounts: null,
        failedDependencies: [],
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: null,
        litestreamAgeSeconds: null,
        adminUrl: "https://admin.socratictrade.com/admin/server",
      },
    }));
    expect(html).toContain("Socratic Trade infrastructure");
    expect(html).toContain("Unreachable");
    expect(html).toContain("scheduler unavailable");
    expect(html).not.toContain("0 GB");
    expect(html).not.toContain("0%");
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
        database: "ok",
        schedulerAgeSeconds: 10,
        activeTradingAccounts: 1,
        degradedTradingAccounts: 0,
        failedDependencies: [],
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: "replicating",
        litestreamAgeSeconds: 10,
        adminUrl: "https://admin.socratictrade.com/admin/server",
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
    });
    expect(stale.receiptInbox.state).toBe("stale");
    expect(stale.socraticInfrastructure.state).toBe("stale");
    expect(stale.receiptInbox.error).toBe("dashboard_refresh_failed");
    expect(stale.r2Fleet?.configured).toBe(false);
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
            label: "Congress Trade",
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
    expect(html).toContain("Congress Trade");
    expect(html).toContain("usage-monitor-prod-v3");
    expect(html).toContain("Status:");
    expect(html).toContain("Class A ops");
    expect(html).toContain("Class B ops");
    expect(html).toContain("Top buckets");
  });
});
