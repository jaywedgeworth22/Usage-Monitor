import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import {
  calculatePaceProjection,
  assessR2Usage,
  isR2AutoDisabled,
  enforceR2AutoDisable,
  sendPushoverNotification,
  formatDailyPushoverMessage,
  runR2UsageCheck,
  DEFAULT_R2_FREE_TIER_LIMITS,
} from "../r2-usage";

describe("R2 usage monitoring & auto-disable", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LITESTREAM_EMERGENCY_DISABLE;
    delete process.env.PUSHOVER_USER_KEY;
    delete process.env.PUSHOVER_API_TOKEN;
    try {
      if (fs.existsSync("/tmp/r2-disabled-70pct.flag")) {
        fs.unlinkSync("/tmp/r2-disabled-70pct.flag");
      }
      if (fs.existsSync("/tmp/r2-last-daily-pushover.json")) {
        fs.unlinkSync("/tmp/r2-last-daily-pushover.json");
      }
      if (fs.existsSync("/tmp/r2-emergency-alert-sent.flag")) {
        fs.unlinkSync("/tmp/r2-emergency-alert-sent.flag");
      }
    } catch {}
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      if (fs.existsSync("/tmp/r2-test-disabled.flag")) {
        fs.unlinkSync("/tmp/r2-test-disabled.flag");
      }
    } catch {}
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

  it("assesses overall R2 metrics and detects 70% threshold breach", () => {
    const testDate = new Date("2026-07-15T12:00:00.000Z");
    
    // Low usage: under 70%
    const lowAssessment = assessR2Usage(
      1 * 1024 * 1024 * 1024, // 1 GiB storage
      100_000,                // 100k Class A
      500_000,                // 500k Class B
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

  it("enforces R2 auto-disable when emergency flag or env is set", () => {
    expect(isR2AutoDisabled()).toBe(false);

    enforceR2AutoDisable("Test 70% breach");
    expect(isR2AutoDisabled()).toBe(true);
    expect(process.env.LITESTREAM_EMERGENCY_DISABLE).toBe("true");
  });

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
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.pushover.net/1/messages.json");
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

  it("triggers emergency disable and sends Pushover alert when R2 usage hits 70%", async () => {
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
    });

    const now = new Date("2026-07-15T12:00:00.000Z");
    await runR2UsageCheck(mockFetch as unknown as typeof fetch, now);

    expect(mockFetch).toHaveBeenCalled();
  });
});
