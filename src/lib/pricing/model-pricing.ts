// Model-pricing lookup + token-cost derivation backed by a bundled snapshot
// of the LiteLLM model_prices_and_context_window.json catalog
// (src/lib/pricing/model-pricing.snapshot.json — regenerate with
// `npm run pricing:update`, see scripts/update-model-pricing.mjs).
//
// Design follows ccusage's pricing architecture (verified against
// github.com/ccusage/ccusage, 2026-07-29):
//   - Bundled, provenance-stamped snapshot instead of a runtime fetch — the
//     read path never depends on GitHub, and pricing changes land as
//     reviewable diffs.
//   - Provider-prefixed model-name candidates: producers report everything
//     from bare `claude-sonnet-4-5` to `openrouter/anthropic/claude-sonnet-4.5`,
//     so lookup tries progressive prefix stripping before a bounded fuzzy
//     match.
//   - Derived cost is a CROSS-CHECK/fallback, never authoritative cash:
//     recorded provider cost always wins (budget-status.ts already enforces
//     that ordering; this module only estimates from tokens).
//
// Known limitation (shared with ccusage): the >200k-context premium tiers
// (`*_above_200k_tokens`) require per-request context size, which neither
// Claude Code OTLP points nor generic ingest events carry. Callers may pass
// `above200k` explicitly; otherwise base rates are used and long-context
// usage is under-priced by the premium delta.

import snapshot from "./model-pricing.snapshot.json";

export interface ModelPricingEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
}

interface PricingSnapshot {
  meta: {
    source: string;
    fetchedAt: string;
    upstreamSha256: string;
    modelCount: number;
  };
  pricing: Record<string, ModelPricingEntry>;
}

const CATALOG = (snapshot as PricingSnapshot).pricing;

/** Live OpenRouter Gemini 3.7 rates (2026-08-14).  The LiteLLM snapshot dump
 *  is not rewritten; these keys are what ingest derivation actually looks up. */
const RUNTIME_PRICING_OVERRIDES: Record<string, ModelPricingEntry> = {
  "gemini-3.7-flash": {
    input_cost_per_token: 3.75e-7,
    output_cost_per_token: 1.875e-6,
    cache_read_input_token_cost: 3.75e-8,
    cache_creation_input_token_cost: 2.08333333333333e-8,
    litellm_provider: "gemini",
    mode: "chat",
  },
  "gemini-3.7-flash:batch": {
    input_cost_per_token: 1.875e-7,
    output_cost_per_token: 9.375e-7,
    cache_read_input_token_cost: 1.875e-8,
    cache_creation_input_token_cost: 2.08333333333333e-8,
    litellm_provider: "gemini",
    mode: "chat",
  },
};

function catalogEntry(key: string): ModelPricingEntry | undefined {
  return RUNTIME_PRICING_OVERRIDES[key] ?? CATALOG[key];
}

/** Provenance of the bundled catalog — surfaced in API responses and UI so a
 * derived cost can always be traced to an exact upstream pricing revision. */
export const PRICING_SNAPSHOT_META = (snapshot as PricingSnapshot).meta;

export interface TokenBreakdown {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface DerivedTokenCost {
  costUsd: number;
  /** False when a token type had a positive count but the catalog entry has
   * no rate for it — costUsd then UNDER-counts and must not be treated as a
   * complete estimate. */
  complete: boolean;
}

// Provider path segments seen in the wild (LiteLLM keys, OpenRouter ids,
// Claude Code model attributes). Stripped progressively during lookup.
const PROVIDER_PREFIXES = [
  "anthropic",
  "openrouter",
  "bedrock",
  "vertex_ai",
  "vertex-ai",
  "gemini",
  "azure",
  "azure_ai",
  "openai",
  "xai",
  "mistral",
  "groq",
  "deepseek",
  "cohere",
  "voyage",
  "cloudflare",
];

const lookupCache = new Map<string, string | null>();

/**
 * Resolve a producer-reported model name to a catalog key, or null when the
 * model is not priced in the snapshot. Deterministic order:
 *   1. exact key (case-sensitive, then lowercased)
 *   2. progressive provider-prefix stripping ("openrouter/anthropic/X" ->
 *      "anthropic/X" -> "X")
 *   3. bounded fuzzy: longest catalog key (>= 8 chars) that is a strict
 *      `key + "-"` prefix of the name — covers date/alias suffixes like
 *      "claude-sonnet-4-5-latest" or "gpt-4o-2024-08-06" variants the
 *      catalog only lists in base form.
 */
export function resolvePricingKey(model: string): string | null {
  const cached = lookupCache.get(model);
  if (cached !== undefined) return cached;

  const key = resolvePricingKeyUncached(model);
  // Bound the cache; model cardinality is naturally small but a hostile or
  // buggy producer could spray unique names.
  if (lookupCache.size > 4096) lookupCache.clear();
  lookupCache.set(model, key);
  return key;
}

function resolvePricingKeyUncached(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (catalogEntry(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (catalogEntry(lower)) return lower;

  if (trimmed.includes("/")) {
    const segments = trimmed.split("/");
    for (let i = 1; i < segments.length; i++) {
      const remainder = segments.slice(i).join("/");
      if (catalogEntry(remainder)) return remainder;
      const remainderLower = remainder.toLowerCase();
      if (catalogEntry(remainderLower)) return remainderLower;
      // Also try stripping just recognized provider segments even when
      // intermediate segments remain (e.g. "openrouter/anthropic/X" -> "X").
      const withoutProviders = segments
        .filter((s) => !PROVIDER_PREFIXES.includes(s.toLowerCase()))
        .join("/");
      if (withoutProviders && catalogEntry(withoutProviders)) return withoutProviders;
    }
  }

  let best: string | null = null;
  for (const key of [...Object.keys(RUNTIME_PRICING_OVERRIDES), ...Object.keys(CATALOG)]) {
    if (key.length < 8 || key.includes("/")) continue;
    if (
      lower.startsWith(`${key.toLowerCase()}-`) &&
      (best === null || key.length > best.length)
    ) {
      best = key;
    }
  }
  return best;
}

/** Catalog entry for a model, or null when unpriced. */
export function getModelPricing(model: string): {
  key: string;
  pricing: ModelPricingEntry;
} | null {
  const key = resolvePricingKey(model);
  if (!key) return null;
  const pricing = catalogEntry(key);
  if (!pricing) return null;
  return { key, pricing };
}

function pickRate(
  base: number | undefined,
  above200k: number | undefined,
  useAbove200k: boolean
): number | undefined {
  if (useAbove200k && above200k != null) return above200k;
  return base;
}

/**
 * Derive an API-equivalent USD cost from a token breakdown. Returns null when
 * the model is unpriced. `complete` is false when a present token type has no
 * catalog rate (cost then under-counts).
 */
export function deriveTokenCostUsd(
  pricing: ModelPricingEntry,
  tokens: TokenBreakdown,
  opts: { above200k?: boolean } = {}
): DerivedTokenCost {
  const above200k = opts.above200k === true;
  let costUsd = 0;
  let complete = true;

  const add = (count: number | undefined, rate: number | undefined) => {
    if (!count || count <= 0) return;
    if (rate == null) {
      complete = false;
      return;
    }
    costUsd += count * rate;
  };

  add(
    tokens.input,
    pickRate(pricing.input_cost_per_token, pricing.input_cost_per_token_above_200k_tokens, above200k)
  );
  add(
    tokens.output,
    pickRate(pricing.output_cost_per_token, pricing.output_cost_per_token_above_200k_tokens, above200k)
  );
  add(
    tokens.cacheRead,
    pickRate(pricing.cache_read_input_token_cost, pricing.cache_read_input_token_cost_above_200k_tokens, above200k)
  );
  add(
    tokens.cacheCreation,
    pickRate(pricing.cache_creation_input_token_cost, pricing.cache_creation_input_token_cost_above_200k_tokens, above200k)
  );

  return { costUsd, complete };
}
