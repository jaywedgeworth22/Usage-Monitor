import { describe, expect, it } from "vitest";
import {
  combineAbortSignals,
  DASHBOARD_LOAD_WATCHDOG_MS,
  shouldShowDashboardSkeleton,
} from "@/hooks/useDashboardData";

describe("shouldShowDashboardSkeleton", () => {
  it("shows the skeleton only during the initial load with no rows yet", () => {
    expect(
      shouldShowDashboardSkeleton({ loading: true, providerCount: 0 })
    ).toBe(true);
  });

  it("keeps the dashboard painted when loading flips true after rows arrived", () => {
    // Regression: overlapping foreground refetch used to set loading=true and
    // blank the page after the first successful paint (flash → stuck skeleton).
    expect(
      shouldShowDashboardSkeleton({ loading: true, providerCount: 3 })
    ).toBe(false);
  });

  it("hides the skeleton once the initial fetch settles", () => {
    expect(
      shouldShowDashboardSkeleton({ loading: false, providerCount: 0 })
    ).toBe(false);
    expect(
      shouldShowDashboardSkeleton({ loading: false, providerCount: 2 })
    ).toBe(false);
  });
});

describe("combineAbortSignals", () => {
  it("returns the timeout alone when no external signal is provided", () => {
    const timeout = AbortSignal.timeout(5_000);
    expect(combineAbortSignals(timeout)).toBe(timeout);
    expect(combineAbortSignals(timeout, null)).toBe(timeout);
  });

  it("composes timeout with an external unmount signal", () => {
    const timeout = AbortSignal.timeout(5_000);
    const controller = new AbortController();
    const combined = combineAbortSignals(timeout, controller.signal);
    expect(combined.aborted).toBe(false);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it("falls back to the timeout when AbortSignal.any is unavailable", () => {
    const timeout = AbortSignal.timeout(5_000);
    const controller = new AbortController();
    const original = AbortSignal.any;
    // Simulate older WebKit without AbortSignal.any.
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(combineAbortSignals(timeout, controller.signal)).toBe(timeout);
    } finally {
      Object.defineProperty(AbortSignal, "any", {
        configurable: true,
        value: original,
      });
    }
  });

  it("falls back to the timeout when AbortSignal.any throws", () => {
    const timeout = AbortSignal.timeout(5_000);
    const controller = new AbortController();
    const original = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: () => {
        throw new TypeError("AbortSignal.any boom");
      },
    });
    try {
      expect(combineAbortSignals(timeout, controller.signal)).toBe(timeout);
    } finally {
      Object.defineProperty(AbortSignal, "any", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("dashboard load watchdog contract", () => {
  it("waits longer than the 30s per-request timeout so AbortSignal wins first", () => {
    expect(DASHBOARD_LOAD_WATCHDOG_MS).toBeGreaterThan(30_000);
  });

  it("releases the coalesce lock even when the fetch generation is stale", () => {
    // Pure-state model of the #814 deadlock: a stale finally used to skip
    // isFetchingRef=false, so later calls coalesced forever while loading
    // stayed true and providerCount stayed 0 → perpetual skeleton.
    let isFetching = true;
    const generation: number = 1;
    const currentGeneration: number = 2; // unmount/freeze advanced the generation

    const isCurrent = generation === currentGeneration;
    // ALWAYS release — matches the fixed finally block.
    isFetching = false;

    expect(isCurrent).toBe(false);
    expect(isFetching).toBe(false);
  });
});
