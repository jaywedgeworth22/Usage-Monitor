import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  calculatePaceProjection,
  assessR2Usage,
  isR2AutoDisabled,
  enforceR2AutoDisable,
  sendPushoverNotification,
  formatDailyPushoverMessage,
  runR2UsageCheck,
  parseR2GraphqlUsage,
  classifyR2Action,
  isLitestreamR2Endpoint,
  resolveR2UsageCredentials,
  DEFAULT_R2_FREE_TIER_LIMITS,
  R2_DISABLED_FLAG_FILENAME,
  __getR2FlagFilePathForTests,
  __resetR2UsageStateForTests,
} from "../r2-usage";

// Flag files live under /data when the persistent volume exists (production
// containers); these tests exercise the private mkdtemp fallback used
// everywhere else.
const hasDataVolume = fs.existsSync("/data");

describe("R2 usage monitoring & auto-disable", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LITESTREAM_EMERGENCY_DISABLE;
    delete process.env.R2_WRITES_DISABLED;
    delete process.env.PUSHOVER_USER_KEY;
    delete process.env.PUSHOVER_API_TOKEN;
    delete process.env.R2_USAGE_ACCOUNT_ID;
    delete process.env.R2_USAGE_API_TOKEN;
    delete process.env.CLOUDFLARE_JAY_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_JAY_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.LITESTREAM_S3_ENDPOINT;
    delete process.env.AWS_S3_ENDPOINT;
    __resetR2UsageStateForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    __resetR2UsageStateForTests();
  });

  it("calculates linear month pace projection accurately", () => {
    // July 15th 12:00:00 UTC = ~50% elapsed month
    const testDate = new Date("2026-07-15T12:00:00.000Z");
    const limit = 1_000_000;

    // 300,000 ops at 50% elapsed = 600,000 projected (60% projected pace)
    const statusLow = calculatePaceProjection(300_000, limit, testDate, 70);
    expect(statusLow.onTrackToExceed).toBe(false);
    expect(statusLow.projectedPct).toBeLessThan(70);

    // 400,000 ops at 50% elapsed = 800,000 projected (80% projected pace)
    const statusHigh = calculatePaceProjection(400_000, limit, testDate, 70);
    expect(statusHigh.onTrackToExceed).toBe(true);
    expect(statusHigh.projectedPct).toBeGreaterThanOrEqual(70);
  });

  it("trips on MTD share alone when already over 70% late in the month", () => {
    // Day 30 of a 31-day month: elapsed ~97%, so projection ≈ MTD.
    // 7.5 GiB / 10 GiB = 75% actual must trip even without growth.
    const lateMonth = new Date("2026-07-30T12:00:00.000Z");
    const status = calculatePaceProjection(
      7.5 * 1024 * 1024 * 1024,
      DEFAULT_R2_FREE_TIER_LIMITS.storageBytes,
      lateMonth,
      70
    );
    expect(status.mtdPct).toBeGreaterThanOrEqual(70);
    expect(status.onTrackToExceed).toBe(true);
  });

  it("assesses overall R2 metrics and detects 70% threshold breach", () => {
    const testDate = new Date("2026-07-15T12:00:00.000Z");

    const lowAssessment = assessR2Usage(
      1 * 1024 * 1024 * 1024, // 1 GiB storage
      100_000, // 100k Class A
      500_000, // 500k Class B
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );
    expect(lowAssessment.overallOnTrackToExceed70Pct).toBe(false);
    expect(lowAssessment.exceededMetric).toBeUndefined();

    // High Class A usage: 400k at mid-month = 80% pace >= 70%
    const highAssessment = assessR2Usage(
      1 * 1024 * 1024 * 1024,
      400_000,
      500_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );
    expect(highAssessment.overallOnTrackToExceed70Pct).toBe(true);
    expect(highAssessment.exceededMetric).toBe("classA");
  });

  it("classifies Class A/B actions with conservative unknown-as-A default", () => {
    expect(classifyR2Action("PutObject")).toBe("A");
    expect(classifyR2Action("ListObjects")).toBe("A");
    expect(classifyR2Action("GetObject")).toBe("B");
    expect(classifyR2Action("HeadBucket")).toBe("B");
    expect(classifyR2Action("SomeFutureWriteOp")).toBe("A");
  });

  it("detects Cloudflare R2 endpoints and ignores Garage", () => {
    expect(
      isLitestreamR2Endpoint(
        "https://abc123.r2.cloudflarestorage.com"
      )
    ).toBe(true);
    expect(
      isLitestreamR2Endpoint("https://abc123.r2.cloudflarestorage.com/path")
    ).toBe(true);
    expect(
      isLitestreamR2Endpoint("https://garage.example.com:9443")
    ).toBe(false);
    // Substring spoofs must not count as R2 (hostname is parsed).
    expect(
      isLitestreamR2Endpoint(
        "https://evil.example/r2.cloudflarestorage.com"
      )
    ).toBe(false);
    expect(
      isLitestreamR2Endpoint(
        "https://r2.cloudflarestorage.com.evil.example"
      )
    ).toBe(false);
    expect(isLitestreamR2Endpoint("")).toBe(false);
    expect(isLitestreamR2Endpoint(undefined)).toBe(false);
  });

  it("resolves usage credentials from env with R2_USAGE_* preferred", () => {
    expect(resolveR2UsageCredentials({})).toBeNull();
    expect(
      resolveR2UsageCredentials({
        CLOUDFLARE_JAY_ACCOUNT_ID: "acct",
        CLOUDFLARE_JAY_API_TOKEN: "tok",
      })
    ).toEqual({ accountId: "acct", apiToken: "tok" });
    expect(
      resolveR2UsageCredentials({
        R2_USAGE_ACCOUNT_ID: "r2acct",
        R2_USAGE_API_TOKEN: "r2tok",
        CLOUDFLARE_JAY_ACCOUNT_ID: "acct",
        CLOUDFLARE_JAY_API_TOKEN: "tok",
      })
    ).toEqual({ accountId: "r2acct", apiToken: "r2tok" });
  });

  it("parses GraphQL analytics into storage + Class A/B totals", () => {
    const metrics = parseR2GraphqlUsage({
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 1000 },
                  dimensions: { actionType: "PutObject" },
                },
                {
                  sum: { requests: 2000 },
                  dimensions: { actionType: "ListObjects" },
                },
                {
                  sum: { requests: 500 },
                  dimensions: { actionType: "GetObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: 5 * 1024 * 1024 * 1024,
                    metadataSize: 1024,
                    objectCount: 10,
                  },
                  dimensions: {
                    datetime: "2026-08-03T12:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
                {
                  max: {
                    payloadSize: 1 * 1024 * 1024 * 1024,
                    metadataSize: 0,
                    objectCount: 2,
                  },
                  dimensions: {
                    datetime: "2026-08-03T11:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
                {
                  max: {
                    payloadSize: 100,
                    metadataSize: 0,
                    objectCount: 1,
                  },
                  dimensions: {
                    datetime: "2026-08-03T12:00:00Z",
                    bucketName: "usage-monitor-receipts",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    expect(metrics.classAOps).toBe(3000);
    expect(metrics.classBOps).toBe(500);
    // Latest sample only per bucket (datetime_DESC order in fixture).
    expect(metrics.storageBytes).toBe(5 * 1024 * 1024 * 1024 + 1024 + 100);
    expect(metrics.buckets).toHaveLength(2);
    expect(metrics.buckets[0].bucketName).toBe("usage-monitor-bucket");
  });

  it("enforces R2 auto-disable when emergency flag or env is set", () => {
    expect(isR2AutoDisabled()).toBe(false);

    enforceR2AutoDisable("Test 70% breach");
    expect(isR2AutoDisabled()).toBe(true);
    expect(process.env.LITESTREAM_EMERGENCY_DISABLE).toBe("true");
    expect(process.env.R2_WRITES_DISABLED).toBe("true");
  });

  it.skipIf(hasDataVolume)(
    "places fallback flag files in a private per-process mkdtemp directory, not a predictable shared temp path",
    () => {
      const flagPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);

      expect(flagPath).not.toBe(path.join(os.tmpdir(), R2_DISABLED_FLAG_FILENAME));
      expect(flagPath).not.toBe(`/tmp/${R2_DISABLED_FLAG_FILENAME}`);

      const flagDir = path.dirname(flagPath);
      expect(path.dirname(flagDir)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(flagDir).startsWith("um-r2-")).toBe(true);
      expect(fs.statSync(flagDir).mode & 0o777).toBe(0o700);
      expect(__getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME)).toBe(
        flagPath
      );
    }
  );

  it.skipIf(hasDataVolume)(
    "writes flag files with owner-only permissions and the expected content",
    () => {
      enforceR2AutoDisable("perm check reason");

      const flagPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);
      const fd = fs.openSync(flagPath, "r");
      try {
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(fd, "utf8")).toContain("perm check reason");
      } finally {
        fs.closeSync(fd);
      }
    }
  );

  it("sends Pushover notifications via HTTP POST to Pushover API", async () => {
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
    });

    const res = await sendPushoverNotification(
      "Test Title",
      "Test Message",
      0,
      mockFetch as unknown as typeof fetch
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.pushover.net/1/messages.json"
    );
  });

  it("formats daily Pushover summary message cleanly", () => {
    const testDate = new Date("2026-07-15T12:00:00.000Z");
    const assessment = assessR2Usage(
      2 * 1024 * 1024 * 1024,
      50_000,
      100_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );

    const { title, body } = formatDailyPushoverMessage(assessment, false);
    expect(title).toContain("Cloudflare R2");
    expect(body).toContain("R2 Storage:");
    expect(body).toContain("Class A Ops:");
    expect(body).toContain("Status: ✅ OK");
  });

  it("does not auto-disable when GraphQL credentials are missing", async () => {
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
    });

    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      new Date("2026-07-15T12:00:00.000Z")
    );

    expect(assessment.metricsSource).toBe("unavailable");
    expect(assessment.metricsError).toMatch(/credentials/i);
    expect(isR2AutoDisabled()).toBe(false);
    // Daily pushover still attempted; no GraphQL call.
    expect(
      mockFetch.mock.calls.some(
        (c) => c[0] === "https://api.cloudflare.com/client/v4/graphql"
      )
    ).toBe(false);
  });

  it("auto-disables from real GraphQL metrics when storage is over 70%", async () => {
    process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
    process.env.R2_USAGE_API_TOKEN = "tok-test";
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";
    process.env.LITESTREAM_S3_ENDPOINT =
      "https://acct.r2.cloudflarestorage.com";

    const storageBytes = 9.3 * 1024 * 1024 * 1024; // ~93% of 10 GiB
    const graphqlBody = {
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 50_000 },
                  dimensions: { actionType: "PutObject" },
                },
                {
                  sum: { requests: 2_000 },
                  dimensions: { actionType: "GetObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: storageBytes,
                    metadataSize: 0,
                    objectCount: 1200,
                  },
                  dimensions: {
                    datetime: "2026-08-03T12:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("graphql")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(graphqlBody),
        };
      }
      // Pushover
      return {
        ok: true,
        status: 200,
        text: async () => '{"status":1}',
      };
    });

    const now = new Date("2026-08-03T12:00:00.000Z");
    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      now
    );

    expect(assessment.metricsSource).toBe("cloudflare_graphql");
    expect(assessment.storage.mtdPct).toBeGreaterThan(90);
    expect(assessment.overallOnTrackToExceed70Pct).toBe(true);
    expect(assessment.exceededMetric).toBe("storage");
    expect(isR2AutoDisabled()).toBe(true);
    expect(assessment.autoDisabled).toBe(true);
    expect(assessment.litestreamUsesR2).toBe(true);
    expect(assessment.buckets?.[0]?.bucketName).toBe("usage-monitor-bucket");

    const graphqlCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("graphql")
    );
    expect(graphqlCall).toBeTruthy();
    expect(graphqlCall?.[1]?.headers?.authorization).toBe("Bearer tok-test");
  });

  it("does not disable when GraphQL reports healthy free-tier usage", async () => {
    process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
    process.env.R2_USAGE_API_TOKEN = "tok-test";

    const graphqlBody = {
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 1_000 },
                  dimensions: { actionType: "PutObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: 0.5 * 1024 * 1024 * 1024,
                    metadataSize: 0,
                    objectCount: 5,
                  },
                  dimensions: {
                    datetime: "2026-08-15T12:00:00Z",
                    bucketName: "small-bucket",
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(graphqlBody),
    });

    // Mid-month, low storage → under 70% projected and MTD
    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      new Date("2026-08-15T12:00:00.000Z")
    );

    expect(assessment.metricsSource).toBe("cloudflare_graphql");
    expect(assessment.overallOnTrackToExceed70Pct).toBe(false);
    expect(isR2AutoDisabled()).toBe(false);
  });
});
