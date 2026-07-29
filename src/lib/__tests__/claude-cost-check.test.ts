import { describe, it, expect } from "vitest";
import { buildClaudeCostCheck } from "../claude-cost-check";

describe("buildClaudeCostCheck", () => {
  it("derives cost from tokens and compares against the reported estimate", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: 1_000_000 },
        { model: "claude-sonnet-4-5", tokenType: "output", quantity: 100_000 },
      ],
      [{ model: "claude-sonnet-4-5", costUsd: 4.0 }]
    );
    const model = report.models[0];
    // derived = $3 (1M input) + $1.50 (100k output) = $4.50
    expect(model.derivedCostUsd).toBeCloseTo(4.5, 6);
    expect(model.reportedCostUsd).toBeCloseTo(4.0, 6);
    expect(model.deltaUsd).toBeCloseTo(0.5, 6);
    expect(model.deltaPct).toBeCloseTo(0.5 / 4.5, 6);
    expect(model.derivationComplete).toBe(true);
    expect(model.pricingKey).toBe("claude-sonnet-4-5");
  });

  it("marks unpriced models as incomplete and counts them in totals", () => {
    const report = buildClaudeCostCheck(
      [{ model: "brand-new-unpriced-model", tokenType: "input", quantity: 5000 }],
      []
    );
    expect(report.models[0].derivationComplete).toBe(false);
    expect(report.models[0].derivedCostUsd).toBe(0);
    expect(report.totals.unpricedModelCount).toBe(1);
  });

  it("buckets unrecognized token types as unknown and incomplete", () => {
    const report = buildClaudeCostCheck(
      [{ model: "claude-sonnet-4-5", tokenType: "mystery", quantity: 100 }],
      []
    );
    expect(report.models[0].tokens.unknown).toBe(100);
    expect(report.models[0].derivationComplete).toBe(false);
  });

  it("handles cost-only models (tokens reported nowhere) with a null deltaPct basis", () => {
    const report = buildClaudeCostCheck(
      [],
      [{ model: "claude-opus-4-1", costUsd: 2.5 }]
    );
    expect(report.models[0].reportedCostUsd).toBeCloseTo(2.5, 6);
    expect(report.models[0].derivedCostUsd).toBe(0);
    expect(report.models[0].deltaUsd).toBeCloseTo(-2.5, 6);
    expect(report.models[0].deltaPct).toBeCloseTo(-1, 6);
  });

  it("ignores non-positive quantities and costs entirely", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: 0 },
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: -10 },
      ],
      [{ model: "claude-sonnet-4-5", costUsd: -1 }]
    );
    expect(report.models).toHaveLength(0);
    expect(report.totals.derivedCostUsd).toBe(0);
    expect(report.totals.reportedCostUsd).toBe(0);
    expect(report.totals.deltaPct).toBeNull();
  });

  it("groups null models under a stable label", () => {
    const report = buildClaudeCostCheck(
      [{ model: null, tokenType: "input", quantity: 1000 }],
      [{ model: null, costUsd: 0.01 }]
    );
    expect(report.models[0].model).toBe("(no model)");
  });

  it("sorts models by largest cost surface first", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: 1_000_000 },
        { model: "claude-haiku-4-5", tokenType: "input", quantity: 1_000_000 },
      ],
      []
    );
    expect(report.models[0].model).toBe("claude-sonnet-4-5");
  });
});
