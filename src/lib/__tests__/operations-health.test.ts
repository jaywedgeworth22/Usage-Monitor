import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCoolifyFleetSummary,
  fetchOperationsHealth,
  fetchReceiptInboxSummary,
  fetchSocraticInfrastructureSummary,
  resetOperationsHealthCacheForTests,
} from "../operations-health";

const ORIGINAL_ENV = { ...process.env };

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    checks: {
      release: {
        sha: "70a2a39df5df8202f3061245f24b7e41b3142728",
        processStartedAt: "2026-08-10T12:00:00.000Z",
        processUptimeSeconds: 7200,
      },
      db: "ok",
      schedulerAgeSeconds: 13,
      tradingLiveness: { activeAccounts: 3, degraded: 0, marketOpen: true },
      dependencies: { fmp: { ok: true }, "alpha-vantage": { ok: false } },
      pineconeConfigured: true,
      ragEmbedProvider: "openrouter",
      openrouterCredits: { ok: true, thresholdUsd: 3 },
      storage: {
        dbSizeBytes: 393469952,
        walSizeBytes: 105954072,
        freeBytes: 55895486464,
        totalBytes: 80290492416,
        litestreamStatus: "replicating",
        litestreamAgeSeconds: 0,
      },
      ...overrides,
    },
  };
}

describe("operations health", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RECEIPT_INBOX_READ_TOKEN;
    // Fleet R2 GraphQL must not fire during these unit tests.
    for (const key of [
      "R2_USAGE_ACCOUNT_ID",
      "R2_USAGE_API_TOKEN",
      "CLOUDFLARE_JAY_ACCOUNT_ID",
      "CLOUDFLARE_JAY_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_FLEET_API_TOKEN",
      "CLOUDFLARE_ST_ACCOUNT_ID",
      "CLOUDFLARE_ST_API_TOKEN",
      "CLOUDFLARE_CT_ACCOUNT_ID",
      "CLOUDFLARE_CT_API_TOKEN",
      "CLOUDFLARE_OLD_ACCOUNT_ID",
      "CLOUDFLARE_OLD_API_TOKEN",
      "LITESTREAM_S3_ENDPOINT",
      "AWS_S3_ENDPOINT",
      "LITESTREAM_S3_ACCESS_KEY_ID",
      "LITESTREAM_S3_SECRET_ACCESS_KEY",
      "LITESTREAM_S3_BUCKET",
      "COOLIFY_SERVER_STATS",
      "COOLIFY_API_TOKEN",
      "COOLIFY_AGENTS",
      "COOLIFY_HOST",
    ]) {
      delete process.env[key];
    }
    resetOperationsHealthCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetOperationsHealthCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns a compact degraded Socratic summary without account or host identifiers", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(healthBody())
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result).toMatchObject({
      state: "degraded",
      database: "ok",
      schedulerAgeSeconds: 13,
      activeTradingAccounts: 3,
      degradedTradingAccounts: 0,
      failedDependencies: ["alpha-vantage"],
      dependencyCount: 2,
      litestreamState: "replicating",
      processUptimeSeconds: 7200,
      recentRestart: false,
      pineconeConfigured: true,
      ragEmbedProvider: "openrouter",
      openrouterCreditsOk: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("accountNumber");
    expect(serialized).not.toContain("135.181.192.190");
  });

  it("does not hard-degrade Peer App Health on overnight VIX misses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(
        healthBody({
          tradingLiveness: { activeAccounts: 2, degraded: 0, marketOpen: false },
          dataProvidersDegraded: true,
          dependencies: {
            fmp: { ok: true },
            "vix-cboe": { ok: false },
            "vix-yahoo": { ok: false },
          },
        })
      )
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result.state).toBe("healthy");
    expect(result.failedDependencies).toEqual([]);
    expect(result.dataProvidersDegraded).toBe(true);
    expect(result.marketOpen).toBe(false);
  });

  it("preserves last-good Socratic data as explicitly stale after an outage", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce(Response.json(healthBody({ dependencies: {} })));
    const fresh = await fetchSocraticInfrastructureSummary();
    expect(fresh.state).toBe("healthy");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const stale = await fetchSocraticInfrastructureSummary();
    expect(stale.state).toBe("stale");
    expect(stale.releaseSha).toBe(fresh.releaseSha);
    expect(stale.error).toBe("network down");
  });

  it("flags recent process restarts as degraded even when ok is true", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(
        healthBody({
          dependencies: {},
          release: {
            sha: "06d50e9950c27a9b918a322176f21f3dacb7e0e6",
            processStartedAt: "2026-08-10T23:47:25.801Z",
            processUptimeSeconds: 90,
          },
        })
      )
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result.recentRestart).toBe(true);
    expect(result.state).toBe("degraded");
    expect(result.processUptimeSeconds).toBe(90);
  });

  it("lists Coolify applications and server resources when configured", async () => {
    process.env.COOLIFY_SERVER_STATS = "stats-token-with-enough-length";
    process.env.COOLIFY_HOST = "https://host.jays.services";
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/applications")) {
        return Response.json([
          {
            uuid: "d83b1aykr03uwr32yhgzaiay",
            name: "socratic-app",
            status: "running:healthy",
            fqdn: "https://socratictrade.com",
          },
          {
            uuid: "yagelvqux9e8l1kztif7bf2o",
            name: "usage-monitor",
            status: "running:healthy",
            fqdn: "https://usage.jays.services",
          },
        ]);
      }
      if (url.endsWith("/api/v1/servers")) {
        return Response.json([{ uuid: "jxzqcs3h6g1wiipnnblhismp", name: "fleet-hetzner" }]);
      }
      if (url.includes("/resources")) {
        return Response.json([
          { name: "socratic-app", type: "application", status: "running:healthy" },
          { name: "usage-monitor", type: "application", status: "running:healthy" },
          { name: "congress-trade", type: "application", status: "running:unknown" },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await fetchCoolifyFleetSummary();
    expect(result.configured).toBe(true);
    expect(result.state).toBe("healthy");
    expect(result.applications).toHaveLength(2);
    expect(result.resources).toHaveLength(3);
    expect(result.appsUp).toBe(2);
    expect(result.resources.some((r) => r.name === "congress-trade")).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps Coolify fleet unconfigured without inventing services", async () => {
    delete process.env.COOLIFY_SERVER_STATS;
    delete process.env.COOLIFY_API_TOKEN;
    const fetchMock = vi.spyOn(global, "fetch");
    const result = await fetchCoolifyFleetSummary();
    expect(result.configured).toBe(false);
    expect(result.state).toBe("unconfigured");
    expect(result.applications).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

    it("keeps the receipt inbox visibly unconfigured and makes no receipt request", async () => {
    delete process.env.COOLIFY_SERVER_STATS;
    delete process.env.COOLIFY_API_TOKEN;
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(Response.json(healthBody()));
    const result = await fetchOperationsHealth();
    expect(result.receiptInbox.state).toBe("unconfigured");
    expect(result.receiptInbox.configured).toBe(false);
    expect(result.coolifyFleet.configured).toBe(false);
    expect(result.r2Fleet?.configured).toBe(false);
    expect(result.r2Fleet?.accounts).toHaveLength(4);
    expect(result.fleetBackups).not.toBeNull();
    expect(result.fleetBackups?.apps.map((a) => a.id)).toEqual([
      "usage-monitor",
      "socratic-trade",
      "congress-trade",
    ]);
    // ST peer health + Socratic infrastructure share one public health URL in this fixture.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("socratictrade.com/api/health"))
    ).toBe(true);
  });

  it("single-flights and briefly caches dashboard refreshes across tabs", async () => {
    delete process.env.COOLIFY_SERVER_STATS;
    delete process.env.COOLIFY_API_TOKEN;
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(Response.json(healthBody({ dependencies: {} })));
    const [first, second] = await Promise.all([fetchOperationsHealth(), fetchOperationsHealth()]);
    const third = await fetchOperationsHealth();
    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses bounded receipt metadata and never returns private content fields", async () => {
    process.env.RECEIPT_INBOX_READ_TOKEN = "r".repeat(32);
    vi.spyOn(global, "fetch").mockResolvedValue(Response.json({
      configured: true,
      status: "receiving",
      needsReviewCount: 1,
      countIsLowerBound: false,
      latestReceivedAt: "2026-07-18T10:00:00.000Z",
      items: [{
        id: "a".repeat(64),
        receivedAt: "2026-07-18T10:00:00.000Z",
        senderDomain: "openai.com",
        senderAuthentication: "passed",
        rawSizeBytes: 1024,
        attachmentCount: 1,
        supportedAttachmentCount: 1,
        bodyEvidence: true,
        quarantineReason: "awaiting_review",
        subject: "private receipt",
        sender: "person@example.com",
      }],
    }));
    const result = await fetchReceiptInboxSummary();
    expect(result.state).toBe("receiving");
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private receipt");
    expect(JSON.stringify(result)).not.toContain("person@example.com");
  });
});
