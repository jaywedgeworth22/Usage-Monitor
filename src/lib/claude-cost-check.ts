// Claude Code cost cross-check: independently re-derives API-equivalent cost
// from ingested token.usage rows (model x token-type x LiteLLM catalog price)
// and compares it against Claude Code's own claude_code.cost.usage estimate.
//
// Why (ccusage lesson, github.com/ccusage/ccusage): never trust a single cost
// signal. ccusage prefers recorded cost but derives token-priced cost as a
// fallback; we go one step further and treat the derived figure purely as a
// drift detector for the recorded one. Both figures are analytics-only
// API-equivalent estimates — cash spend still comes from receipts/subscriptions
// (see budget-status.ts) and this module never feeds budget math.

import {
  deriveTokenCostUsd,
  getModelPricing,
  PRICING_SNAPSHOT_META,
} from "@/lib/pricing/model-pricing";

export interface ClaudeTokenEventRow {
  /** Model name (keyRef), may be null. */
  model: string | null;
  /** claude-code token type: input | output | cacheRead | cacheCreation | unknown */
  tokenType: string;
  quantity: number;
}

export interface ClaudeCostEventRow {
  model: string | null;
  costUsd: number;
}

export interface ModelCostCheck {
  model: string;
  pricingKey: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    unknown: number;
  };
  /** Token x catalog price, API-equivalent USD. */
  derivedCostUsd: number;
  /** False when some tokens could not be priced (unknown model or missing
   * rate) — derivedCostUsd then under-counts. */
  derivationComplete: boolean;
  /** Claude Code's own claude_code.cost.usage estimate, summed. */
  reportedCostUsd: number;
  /** derived - reported (positive = our derivation is higher). */
  deltaUsd: number;
  /** delta / max(reported, epsilon), null when both are ~0. */
  deltaPct: number | null;
}

export interface ClaudeCostCheckReport {
  pricing: {
    source: string;
    fetchedAt: string;
    upstreamSha256: string;
  };
  models: ModelCostCheck[];
  totals: {
    derivedCostUsd: number;
    reportedCostUsd: number;
    deltaUsd: number;
    deltaPct: number | null;
    unpricedModelCount: number;
  };
}

const TOKEN_TYPE_KEYS = ["input", "output", "cacheRead", "cacheCreation"] as const;
type KnownTokenType = (typeof TOKEN_TYPE_KEYS)[number];

function isKnownTokenType(value: string): value is KnownTokenType {
  return (TOKEN_TYPE_KEYS as readonly string[]).includes(value);
}

/** Pure aggregation — rows in, report out. No I/O, fully unit-testable. */
export function buildClaudeCostCheck(
  tokenEvents: ClaudeTokenEventRow[],
  costEvents: ClaudeCostEventRow[]
): ClaudeCostCheckReport {
  const byModel = new Map<string, ModelCostCheck>();

  const ensure = (model: string | null): ModelCostCheck => {
    const key = model?.trim() || "(no model)";
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        model: key,
        pricingKey: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unknown: 0 },
        derivedCostUsd: 0,
        derivationComplete: true,
        reportedCostUsd: 0,
        deltaUsd: 0,
        deltaPct: null,
      };
      byModel.set(key, entry);
    }
    return entry;
  };

  for (const event of tokenEvents) {
    if (!Number.isFinite(event.quantity) || event.quantity <= 0) continue;
    const entry = ensure(event.model);
    if (isKnownTokenType(event.tokenType)) {
      entry.tokens[event.tokenType] += event.quantity;
    } else {
      entry.tokens.unknown += event.quantity;
      entry.derivationComplete = false;
    }
  }

  for (const event of costEvents) {
    if (!Number.isFinite(event.costUsd) || event.costUsd <= 0) continue;
    ensure(event.model).reportedCostUsd += event.costUsd;
  }

  for (const entry of byModel.values()) {
    if (entry.model !== "(no model)") {
      const resolved = getModelPricing(entry.model);
      if (resolved) {
        entry.pricingKey = resolved.key;
        const derived = deriveTokenCostUsd(resolved.pricing, {
          input: entry.tokens.input,
          output: entry.tokens.output,
          cacheRead: entry.tokens.cacheRead,
          cacheCreation: entry.tokens.cacheCreation,
        });
        entry.derivedCostUsd = derived.costUsd;
        if (!derived.complete) entry.derivationComplete = false;
      } else if (
        entry.tokens.input + entry.tokens.output + entry.tokens.cacheRead + entry.tokens.cacheCreation > 0
      ) {
        entry.derivationComplete = false;
      }
    }
    entry.deltaUsd = entry.derivedCostUsd - entry.reportedCostUsd;
    const basis = Math.max(entry.reportedCostUsd, entry.derivedCostUsd);
    entry.deltaPct = basis > 1e-9 ? entry.deltaUsd / basis : null;
  }

  const models = [...byModel.values()].sort(
    (a, b) =>
      Math.max(b.derivedCostUsd, b.reportedCostUsd) - Math.max(a.derivedCostUsd, a.reportedCostUsd)
  );

  const derivedCostUsd = models.reduce((sum, m) => sum + m.derivedCostUsd, 0);
  const reportedCostUsd = models.reduce((sum, m) => sum + m.reportedCostUsd, 0);
  const deltaUsd = derivedCostUsd - reportedCostUsd;
  const basis = Math.max(reportedCostUsd, derivedCostUsd);

  return {
    pricing: {
      source: PRICING_SNAPSHOT_META.source,
      fetchedAt: PRICING_SNAPSHOT_META.fetchedAt,
      upstreamSha256: PRICING_SNAPSHOT_META.upstreamSha256,
    },
    models,
    totals: {
      derivedCostUsd,
      reportedCostUsd,
      deltaUsd,
      deltaPct: basis > 1e-9 ? deltaUsd / basis : null,
      unpricedModelCount: models.filter(
        (m) =>
          !m.derivationComplete &&
          m.pricingKey === null &&
          m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheCreation > 0
      ).length,
    },
  };
}
