import { describe, expect, it } from "vitest";
import {
  buildProviderAlertState,
  buildProjectBudgetAlerts,
  PROVIDER_ALERT_CODES,
  resolveBudgetAlertTier,
} from "@/lib/provider-alerts";
import type { AnomalyResult } from "@/lib/anomaly-detection";

describe("resolveBudgetAlertTier hysteresis (C9)", () => {
  it("enters warning at 80% and exceeded at 100% from ok", () => {
    expect(resolveBudgetAlertTier(79, 100, "ok")).toBe("ok");
    expect(resolveBudgetAlertTier(80, 100, "ok")).toBe("warning");
    expect(resolveBudgetAlertTier(100, 100, "ok")).toBe("exceeded");
  });

  it("stays exceeded until spend clears below 95%", () => {
    expect(resolveBudgetAlertTier(96, 100, "exceeded")).toBe("exceeded");
    expect(resolveBudgetAlertTier(94, 100, "exceeded")).toBe("warning");
    expect(resolveBudgetAlertTier(74, 100, "exceeded")).toBe("ok");
  });

  it("stays in warning until spend clears below 75%", () => {
    expect(resolveBudgetAlertTier(76, 100, "warning")).toBe("warning");
    expect(resolveBudgetAlertTier(74, 100, "warning")).toBe("ok");
    expect(resolveBudgetAlertTier(100, 100, "warning")).toBe("exceeded");
  });
});


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

describe("buildProviderAlertState anomaly emission", () => {
  const costAnomaly: AnomalyResult = {
    providerId: "prov-1",
    metric: "cost",
    day: "2026-07-19",
    observed: 100,
    baselineCenter: 10,
    baselineSpread: 1.48,
    expectedLow: 4.82,
    expectedHigh: 15.18,
    sigmas: 60,
    severity: "critical",
    method: "mad",
    windowSize: 10,
  };

  it("emits a spend_anomaly alert from a pre-computed cost anomaly", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        plan: null,
        latestSnapshot: null,
        snapshotExpected: false,
        anomalies: [costAnomaly],
      },
      new Date("2026-07-19T12:00:00.000Z")
    );

    expect(state.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "spend_anomaly", severity: "critical" }),
      ])
    );
    const alert = state.alerts.find((a) => a.code === "spend_anomaly");
    expect(alert?.message).toContain("Spend spike");
  });

  it("maps the requests metric to a request_anomaly code", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        plan: null,
        latestSnapshot: null,
        snapshotExpected: false,
        anomalies: [{ ...costAnomaly, metric: "requests", severity: "warning" }],
      },
      new Date("2026-07-19T12:00:00.000Z")
    );
    expect(state.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "request_anomaly", severity: "warning" }),
      ])
    );
  });

  it("emits no anomaly alert when none are supplied", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        plan: null,
        latestSnapshot: null,
        snapshotExpected: false,
      },
      new Date("2026-07-19T12:00:00.000Z")
    );
    expect(state.alerts.some((a) => a.code === "spend_anomaly" || a.code === "request_anomaly")).toBe(false);
  });
});

describe("PROVIDER_ALERT_CODES runtime list", () => {
  it("includes the project and subscription insight codes", () => {
    for (const code of [
      "project_budget_exceeded",
      "project_budget_warning",
      "project_spend_anomaly",
      "unassigned_spend",
      "unused_subscription",
      "possible_duplicate_subscription",
      "price_change_detected",
    ] as const) {
      expect(PROVIDER_ALERT_CODES).toContain(code);
    }
  });
});

describe("buildProjectBudgetAlerts (S1)", () => {
  const projects = [
    { id: "proj-a", name: "Alpha", monthlyBudgetUsd: 100, spentUsd: 120 },
    { id: "proj-b", name: "Beta", monthlyBudgetUsd: 100, spentUsd: 85 },
    { id: "proj-c", name: "Calm", monthlyBudgetUsd: 100, spentUsd: 10 },
    { id: "proj-d", name: "NoBudget", monthlyBudgetUsd: null, spentUsd: 999 },
  ];

  it("emits exceeded/warning per project with scope = project id", () => {
    const alerts = buildProjectBudgetAlerts({ projects });
    const exceeded = alerts.find((a) => a.code === "project_budget_exceeded");
    const warning = alerts.find((a) => a.code === "project_budget_warning");
    expect(exceeded).toMatchObject({
      severity: "critical",
      scope: "proj-a",
    });
    expect(exceeded?.message).toContain('Project "Alpha"');
    expect(exceeded?.message).toContain("$120.00");
    expect(exceeded?.message).toContain("$100.00");
    expect(warning).toMatchObject({ severity: "warning", scope: "proj-b" });
    // Calm and budget-less projects produce no budget alerts.
    expect(alerts).toHaveLength(2);
  });

  it("respects prior-tier hysteresis (stays exceeded below 100% but above 95%)", () => {
    const alerts = buildProjectBudgetAlerts({
      projects: [{ id: "proj-a", name: "Alpha", monthlyBudgetUsd: 100, spentUsd: 96 }],
      previousTierByProjectId: new Map([["proj-a", "exceeded" as const]]),
    });
    expect(alerts).toEqual([
      expect.objectContaining({ code: "project_budget_exceeded", scope: "proj-a" }),
    ]);
  });

  it("clears to warning from a prior exceeded tier between 75% and 95%", () => {
    const alerts = buildProjectBudgetAlerts({
      projects: [{ id: "proj-a", name: "Alpha", monthlyBudgetUsd: 100, spentUsd: 80 }],
      previousTierByProjectId: new Map([["proj-a", "exceeded" as const]]),
    });
    expect(alerts).toEqual([
      expect.objectContaining({ code: "project_budget_warning", scope: "proj-a" }),
    ]);
  });

  it("emits project_spend_anomaly from pre-computed project anomalies", () => {
    const anomaly: AnomalyResult = {
      projectId: "proj-a",
      metric: "cost",
      day: "2026-07-19",
      observed: 90,
      baselineCenter: 10,
      baselineSpread: 1.48,
      expectedLow: 4.82,
      expectedHigh: 15.18,
      sigmas: 54,
      severity: "critical",
      method: "mad",
      windowSize: 10,
    };
    const alerts = buildProjectBudgetAlerts({
      projects: [{ id: "proj-a", name: "Alpha", monthlyBudgetUsd: null, spentUsd: 0 }],
      anomaliesByProjectId: new Map([["proj-a", [anomaly]]]),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      code: "project_spend_anomaly",
      severity: "critical",
      scope: "proj-a",
    });
    expect(alerts[0]!.message).toContain('Project "Alpha"');
    expect(alerts[0]!.message).toContain("Spend spike");
  });

  it("emits unassigned_spend info only above the floor and only when projects exist", () => {
    const over = buildProjectBudgetAlerts({
      projects,
      unassignedSpentUsd: 30,
      unassignedSpentFloorUsd: 25,
    });
    const unassigned = over.find((a) => a.code === "unassigned_spend");
    expect(unassigned).toMatchObject({ severity: "info" });
    expect(unassigned?.message).toContain("$30.00");
    expect(unassigned?.scope).toBeUndefined();

    const under = buildProjectBudgetAlerts({
      projects,
      unassignedSpentUsd: 24.99,
      unassignedSpentFloorUsd: 25,
    });
    expect(under.some((a) => a.code === "unassigned_spend")).toBe(false);

    // Zero projects: ALL spend is unassigned by definition — never alert.
    const noProjects = buildProjectBudgetAlerts({
      projects: [],
      unassignedSpentUsd: 10_000,
      unassignedSpentFloorUsd: 25,
    });
    expect(noProjects).toHaveLength(0);

    // Floor of 0 disables the alert.
    const disabled = buildProjectBudgetAlerts({
      projects,
      unassignedSpentUsd: 10_000,
      unassignedSpentFloorUsd: 0,
    });
    expect(disabled.some((a) => a.code === "unassigned_spend")).toBe(false);
  });
});
