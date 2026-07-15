import { describe, expect, it } from "vitest";
import {
  acquireInternalUsageWriteAdmission,
  isOtlpMetricsIngestEnabled,
  tryAcquireIngestAdmission,
  withInternalUsageWriteAdmission,
} from "../ingest-admission";

describe("ingest admission", () => {
  it("keeps OTLP metrics enabled unless explicitly set to false", () => {
    expect(isOtlpMetricsIngestEnabled(undefined)).toBe(true);
    expect(isOtlpMetricsIngestEnabled("")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("true")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("0")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("  FaLsE  ")).toBe(false);
  });

  it("admits one writer and rejects overlap until it releases", () => {
    const releaseFirst = tryAcquireIngestAdmission();
    expect(releaseFirst).not.toBeNull();
    expect(tryAcquireIngestAdmission()).toBeNull();

    releaseFirst?.();
    const releaseSecond = tryAcquireIngestAdmission();
    expect(releaseSecond).not.toBeNull();
    releaseSecond?.();
  });

  it("makes release idempotent without releasing a later owner", () => {
    const releaseFirst = tryAcquireIngestAdmission();
    expect(releaseFirst).not.toBeNull();
    releaseFirst?.();

    const releaseSecond = tryAcquireIngestAdmission();
    expect(releaseSecond).not.toBeNull();
    releaseFirst?.();
    expect(tryAcquireIngestAdmission()).toBeNull();
    releaseSecond?.();
  });

  it("queues internal writers FIFO and blocks external ingest while owned", async () => {
    const releaseFirst = await acquireInternalUsageWriteAdmission();
    const order: string[] = [];

    const second = withInternalUsageWriteAdmission(async () => {
      order.push("second");
      expect(tryAcquireIngestAdmission()).toBeNull();
    });
    const third = withInternalUsageWriteAdmission(async () => {
      order.push("third");
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    expect(tryAcquireIngestAdmission()).toBeNull();

    releaseFirst();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("allows nested internal write phases under the same owner", async () => {
    await withInternalUsageWriteAdmission(async () => {
      expect(tryAcquireIngestAdmission()).toBeNull();
      await withInternalUsageWriteAdmission(async () => {
        expect(tryAcquireIngestAdmission()).toBeNull();
      });
    });

    const releaseExternal = tryAcquireIngestAdmission();
    expect(releaseExternal).not.toBeNull();
    releaseExternal?.();
  });
});
