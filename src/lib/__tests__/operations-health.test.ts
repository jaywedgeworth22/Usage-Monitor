import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
      release: { sha: "70a2a39df5df8202f3061245f24b7e41b3142728" },
      db: "ok",
      schedulerAgeSeconds: 13,
      tradingLiveness: { activeAccounts: 3, degraded: 0 },
      dependencies: { fmp: { ok: true }, "alpha-vantage": { ok: false } },
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
      "CLOUDFLARE_ST_ACCOUNT_ID",
      "CLOUDFLARE_ST_API_TOKEN",
      "CLOUDFLARE_CT_ACCOUNT_ID",
      "CLOUDFLARE_CT_API_TOKEN",
      "LITESTREAM_S3_ENDPOINT",
      "AWS_S3_ENDPOINT",
      "LITESTREAM_S3_ACCESS_KEY_ID",
      "LITESTREAM_S3_SECRET_ACCESS_KEY",
      "LITESTREAM_S3_BUCKET",
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
      litestreamState: "replicating",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("accountNumber");
    expect(serialized).not.toContain("135.181.192.190");
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

  it("keeps the receipt inbox visibly unconfigured and makes no receipt request", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(Response.json(healthBody()));
    const result = await fetchOperationsHealth();
    expect(result.receiptInbox.state).toBe("unconfigured");
    expect(result.receiptInbox.configured).toBe(false);
    expect(result.r2Fleet?.configured).toBe(false);
    expect(result.r2Fleet?.accounts).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://socratictrade.com/api/health");
  });

  it("single-flights and briefly caches dashboard refreshes across tabs", async () => {
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
