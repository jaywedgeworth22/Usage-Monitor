import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Covers the stale-while-revalidate cache wrapped around computeBudgetStatus
// (see the "Stale-while-revalidate cache for computeBudgetStatus" block in
// ../budget-status.ts). That cache exists because computeBudgetStatus's
// sumMonthToDateExternalCostByProvider call was measured at ~11.4s in
// production - effectively all of GET /api/providers's ~11.5s - because it
// live-groups the ENTIRE current month of raw ExternalUsageEvent rows on
// every call. These tests prove the cache serves a memoized instance within
// TTL, refreshes in the background once stale without ever blocking the
// caller on the slow recompute, busts at a UTC month boundary, and never
// lets a failed background refresh either crash the process or evict a good
// cached value - all without changing what a fresh computeBudgetStatus call
// would itself compute (the money math is untouched; only its output is
// memoized).
//
// The cache is disabled by default under `vitest run` (see
// budgetStatusCacheEnabled in budget-status.ts) so the rest of the suite -
// which calls computeBudgetStatus/computeProjectBudgetStatus repeatedly with
// a fixed `now` across many distinct DB fixtures in the same file - keeps
// getting a fresh compute every time, exactly as before this change.
// __setBudgetStatusCacheOverrideForTests(true) below forces it on for this
// file only.
let prisma: typeof import("@/lib/prisma").prisma;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let __setBudgetStatusCacheOverrideForTests: typeof import("../budget-status").__setBudgetStatusCacheOverrideForTests;
let __resetBudgetStatusCacheForTests: typeof import("../budget-status").__resetBudgetStatusCacheForTests;

let testDir: string;

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-status-cache-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({
    computeBudgetStatus,
    __setBudgetStatusCacheOverrideForTests,
    __resetBudgetStatusCacheForTests,
  } = await import("../budget-status"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.provider.deleteMany();
  __setBudgetStatusCacheOverrideForTests(true);
  __resetBudgetStatusCacheForTests();
  delete process.env.BUDGET_STATUS_CACHE_TTL_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
  __setBudgetStatusCacheOverrideForTests(null);
  __resetBudgetStatusCacheForTests();
  delete process.env.BUDGET_STATUS_CACHE_TTL_MS;
});

async function createProviderWithCost(name: string, totalCost: number, fetchedAt: Date) {
  return prisma.provider.create({
    data: {
      name,
      displayName: name,
      type: "builtin",
      refreshIntervalMin: 60,
      snapshots: { create: { fetchedAt, totalCost } },
    },
  });
}

describe("computeBudgetStatus stale-while-revalidate cache", () => {
  it("returns the exact cached instance within TTL, without reflecting a DB change made since", async () => {
    const NOW = new Date("2026-03-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-ttl-provider",
      5,
      new Date("2026-03-10T10:00:00.000Z")
    );

    const first = await computeBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // A fresh compute would see this; a cache hit must not.
    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 999 },
    });

    const second = await computeBudgetStatus(NOW);
    expect(second).toBe(first);
    expect(second.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);
  });

  it("serves the stale value immediately past TTL, then refreshes in the background", async () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "10";
    // Each test in this file uses a distinct UTC month for `now`. The TTL
    // here is deliberately shorter than this test's own poll interval, so
    // waitUntil's repeated cache hits keep re-triggering "stale" background
    // refreshes for a bit after the assertions below are satisfied. Giving
    // every test its own month means any such dangling refresh can only ever
    // write back to THIS test's cache key, never bleed into another test's
    // expectations - regardless of exactly when it lands.
    const NOW = new Date("2026-04-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-refresh-provider",
      5,
      new Date("2026-04-10T10:00:00.000Z")
    );

    const first = await computeBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 42 },
    });

    // Past the 10ms TTL: the entry is now stale.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stale = await computeBudgetStatus(NOW);
    // SWR contract: still the OLD cached instance, returned immediately -
    // this call never blocks on the recompute.
    expect(stale).toBe(first);
    expect(stale.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // The stale hit above kicked off a background refresh; once it lands,
    // a later call picks up the new value without any caller having waited
    // on the recompute directly.
    await waitUntil(async () => {
      const probe = await computeBudgetStatus(NOW);
      return probe.providers.find((p) => p.id === provider.id)?.spentUsd === 42;
    });

    const refreshed = await computeBudgetStatus(NOW);
    expect(refreshed).not.toBe(first);
    expect(refreshed.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(42);
  });

  it("busts the cache at a UTC month boundary instead of serving the prior month's numbers", async () => {
    const provider = await createProviderWithCost(
      "cache-month-boundary-provider",
      7,
      new Date("2026-06-15T00:00:00.000Z")
    );

    const june = await computeBudgetStatus(new Date("2026-06-30T23:59:59.000Z"));
    expect(june.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(7);

    const july = await computeBudgetStatus(new Date("2026-07-01T00:00:01.000Z"));
    expect(july).not.toBe(june);
    // The June snapshot falls outside July's month window - a different
    // (lower) number proves this genuinely recomputed rather than reusing
    // June's cache entry under a stale key.
    expect(july.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(0);
  });

  it("keeps serving the last good value when a background refresh fails, and recovers on the next one", async () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "10";
    // Distinct month (see the comment in the previous test) so a dangling
    // background refresh from this test's own tight poll loop can never be
    // mistaken by a later test for that later test's cold-start cache entry.
    const NOW = new Date("2026-05-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-error-provider",
      5,
      new Date("2026-05-10T10:00:00.000Z")
    );

    const first = await computeBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(prisma.provider, "findMany").mockRejectedValueOnce(
      new Error("simulated background refresh failure")
    );

    await new Promise((resolve) => setTimeout(resolve, 30)); // past TTL

    const duringFailedRefresh = await computeBudgetStatus(NOW);
    expect(duringFailedRefresh).toBe(first);
    expect(duringFailedRefresh.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // Let the failed background refresh settle (it must not reject
    // unhandled, and must not crash/hang the module).
    await waitUntil(async () => warnSpy.mock.calls.length > 0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[budget-status-cache] refresh failed; serving last good value if available",
      expect.any(Error)
    );

    // A subsequent (non-mocked) refresh succeeds and replaces the cache.
    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 9 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // past TTL again
    await waitUntil(async () => {
      const probe = await computeBudgetStatus(NOW);
      return probe.providers.find((p) => p.id === provider.id)?.spentUsd === 9;
    });
  });

  it("propagates the error on a cold cache instead of silently swallowing it", async () => {
    // Distinct month, same reasoning as above.
    const NOW = new Date("2026-08-10T12:00:00.000Z");
    await createProviderWithCost(
      "cache-coldstart-provider",
      5,
      new Date("2026-08-10T10:00:00.000Z")
    );

    vi.spyOn(prisma.provider, "findMany").mockRejectedValueOnce(
      new Error("simulated cold-start failure")
    );

    await expect(computeBudgetStatus(NOW)).rejects.toThrow("simulated cold-start failure");
  });
});
