import { describe, expect, it } from "vitest";
import { buildProviderAlertState } from "@/lib/provider-alerts";

describe("buildProviderAlertState snapshot capability", () => {
  it("keeps budget alerts but suppresses impossible snapshot alerts for push/manual tracking", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        snapshotExpected: false,
        plan: {
          billingMode: "actual",
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 10,
          monthlyRequestLimit: null,
          lowBalanceUsd: null,
          lowCredits: null,
          renewalDate: null,
          mustKeepFunded: false,
        },
        latestSnapshot: null,
        trackedSpendUsd: 12,
      },
      new Date("2026-07-14T12:00:00.000Z")
    );

    expect(state.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "budget_exceeded" })])
    );
    expect(state.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_snapshot" }),
      ])
    );
    expect(state.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_snapshot" }),
      ])
    );
  });
});
