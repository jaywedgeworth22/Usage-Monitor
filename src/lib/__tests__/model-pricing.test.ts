import { describe, it, expect } from "vitest";
import {
  deriveTokenCostUsd,
  getModelPricing,
  resolvePricingKey,
  PRICING_SNAPSHOT_META,
} from "../pricing/model-pricing";

describe("resolvePricingKey", () => {
  it("resolves bare catalog keys exactly", () => {
    expect(resolvePricingKey("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("resolves dated model variants directly present in the catalog", () => {
    expect(resolvePricingKey("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5-20250929");
  });

  it("strips provider prefixes progressively", () => {
    expect(resolvePricingKey("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(resolvePricingKey("openrouter/anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("fuzzy-matches alias suffixes to the longest catalog prefix", () => {
    // e.g. a producer reports "claude-sonnet-4-5-latest"; the catalog only
    // lists the base and dated keys.
    expect(resolvePricingKey("claude-sonnet-4-5-latest")).toBe("claude-sonnet-4-5");
  });

  it("returns null for unknown models instead of guessing", () => {
    expect(resolvePricingKey("definitely-not-a-real-model-xyz")).toBeNull();
    expect(resolvePricingKey("")).toBeNull();
  });

  it("caches lookups without changing results", () => {
    const first = resolvePricingKey("gpt-4o");
    const second = resolvePricingKey("gpt-4o");
    expect(first).toBe("gpt-4o");
    expect(second).toBe(first);
  });
});

describe("deriveTokenCostUsd", () => {
  const sonnet = getModelPricing("claude-sonnet-4-5");
  if (!sonnet) throw new Error("snapshot missing claude-sonnet-4-5 canary");

  it("prices all four Claude token types from the catalog", () => {
    const derived = deriveTokenCostUsd(sonnet.pricing, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
    });
    // claude-sonnet-4-5: $3 input, $15 output, $0.30 cache read, $3.75 cache
    // creation per 1M tokens -> $22.05 total.
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBeCloseTo(22.05, 6);
  });

  it("flags incomplete derivation when a present token type has no rate", () => {
    const derived = deriveTokenCostUsd(
      { input_cost_per_token: 1e-6 },
      { input: 1000, cacheRead: 5000 }
    );
    expect(derived.complete).toBe(false);
    expect(derived.costUsd).toBeCloseTo(0.001, 9);
  });

  it("uses >200k-context rates only when explicitly requested", () => {
    const base = deriveTokenCostUsd(sonnet.pricing, { input: 1_000_000 });
    const longCtx = deriveTokenCostUsd(sonnet.pricing, { input: 1_000_000 }, { above200k: true });
    expect(base.costUsd).toBeCloseTo(3, 6);
    // Sonnet doubles input price above 200k context ($3 -> $6 per 1M).
    expect(longCtx.costUsd).toBeCloseTo(6, 6);
  });

  it("treats zero/negative counts as absent rather than incomplete", () => {
    const derived = deriveTokenCostUsd({ input_cost_per_token: 1e-6 }, { input: 0, cacheRead: -5 });
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBe(0);
  });
});

describe("PRICING_SNAPSHOT_META", () => {
  it("carries provenance for the bundled catalog", () => {
    expect(PRICING_SNAPSHOT_META.source).toContain("litellm");
    expect(PRICING_SNAPSHOT_META.modelCount).toBeGreaterThan(1000);
    expect(PRICING_SNAPSHOT_META.upstreamSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
