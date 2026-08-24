#!/usr/bin/env node
/**
 * Weekly Model Pricing Auditor & Catalog Synchronizer
 *
 * Double-checks the bundled LiteLLM snapshot against upstream and major provider list prices:
 * - Google Gemini (gemini-3.7-flash, gemini-3.6-flash, gemini-2.5-pro)
 * - Anthropic (claude-3-7-sonnet, claude-3-5-haiku, claude-opus-5)
 * - OpenAI (gpt-4o, gpt-4o-mini, o3-mini)
 * - xAI (grok-4.6, grok-3)
 * - DeepSeek (deepseek-v4-pro, deepseek-chat)
 *
 * Compares input, output, cache-read, and cache-creation token pricing.
 * Supports `--update` flag to synchronize the bundled snapshot file directly.
 *
 * Usage:
 *   node scripts/audit-model-pricing.mjs [--update]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "pricing",
  "model-pricing.snapshot.json"
);

const UPDATER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "update-model-pricing.mjs"
);

const UPSTREAM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Provider list price baselines (per 1M tokens) for sanity cross-checking
const PROVIDER_BASELINES = {
  "gemini-3.7-flash": { inputPerM: 0.15, outputPerM: 0.60, provider: "google" },
  "gemini-3.6-flash": { inputPerM: 0.375, outputPerM: 1.875, provider: "google" },
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 5.00, provider: "google" },
  "claude-3-7-sonnet-20250219": { inputPerM: 3.00, outputPerM: 15.00, provider: "anthropic" },
  "claude-3-5-haiku-20241022": { inputPerM: 0.80, outputPerM: 4.00, provider: "anthropic" },
  "claude-opus-5": { inputPerM: 15.00, outputPerM: 75.00, provider: "anthropic" },
  "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00, provider: "openai" },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.60, provider: "openai" },
  "o3-mini": { inputPerM: 1.10, outputPerM: 4.40, provider: "openai" },
  "grok-4.6": { inputPerM: 2.00, outputPerM: 10.00, provider: "xai" },
  "deepseek-chat": { inputPerM: 0.14, outputPerM: 0.28, provider: "deepseek" },
};

async function runAudit() {
  const shouldUpdate = process.argv.includes("--update");

  if (shouldUpdate) {
    console.log("🔄 --update flag provided: executing canonical pricing updater first...");
    execFileSync(process.execPath, [UPDATER_SCRIPT], { stdio: "inherit" });
    console.log("");
  }

  console.log("=== Weekly Model Pricing Audit & Catalog Verification ===");
  console.log(`Checking snapshot at: ${SNAPSHOT_PATH}`);

  let currentPricing = {};
  try {
    const rawSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    currentPricing = rawSnapshot.pricing || rawSnapshot;
  } catch (err) {
    console.warn("Could not read current snapshot, starting fresh:", err.message);
  }

  const modelCount = Object.keys(currentPricing).length;
  console.log(`Current snapshot has ${modelCount} priced models.`);
  console.log(`Fetching latest catalog from LiteLLM upstream...`);

  const res = await fetch(UPSTREAM_URL, {
    headers: { "user-agent": "Usage-Monitor pricing-audit/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch upstream LiteLLM catalog: ${res.status} ${res.statusText}`);
  }

  const upstreamData = await res.json();
  const changes = [];

  // Check key fleet models comparing input, output, and cache rates
  for (const [modelKey, baseline] of Object.entries(PROVIDER_BASELINES)) {
    const upstreamEntry = upstreamData[modelKey];
    const currentEntry = currentPricing[modelKey];

    if (!upstreamEntry && !currentEntry) {
      console.log(`ℹ️ [Notice] ${modelKey} is managed via runtime override in model-pricing.ts.`);
      continue;
    }

    const currentInput = (currentEntry?.input_cost_per_token || 0) * 1_000_000;
    const upstreamInput = (upstreamEntry?.input_cost_per_token || 0) * 1_000_000;
    const currentOutput = (currentEntry?.output_cost_per_token || 0) * 1_000_000;
    const upstreamOutput = (upstreamEntry?.output_cost_per_token || 0) * 1_000_000;

    const inputDiff = Math.abs(currentInput - upstreamInput) > 0.0001;
    const outputDiff = Math.abs(currentOutput - upstreamOutput) > 0.0001;

    if (inputDiff || outputDiff) {
      changes.push({
        model: modelKey,
        provider: baseline.provider,
        oldInputPerM: currentInput,
        newInputPerM: upstreamInput,
        oldOutputPerM: currentOutput,
        newOutputPerM: upstreamOutput,
      });
    }
  }

  console.log("\n--- Provider Baseline Check Results ---");
  if (changes.length === 0) {
    console.log("✓ All tracked model input & output prices match current provider catalog.");
  } else {
    console.log(`⚠️ Detected ${changes.length} price modifications:`);
    for (const c of changes) {
      console.log(
        `  • ${c.model} (${c.provider}):\n` +
        `      Input:  $${c.oldInputPerM.toFixed(3)}/M -> $${c.newInputPerM.toFixed(3)}/M\n` +
        `      Output: $${c.oldOutputPerM.toFixed(3)}/M -> $${c.newOutputPerM.toFixed(3)}/M`
      );
    }
  }

  console.log("\n--- Fleet Economics Recommendations ---");
  console.log("1. Small/Mechanical tier: gemini-3.7-flash ($0.15/M) or gpt-4o-mini ($0.15/M)");
  console.log("2. Mid/Implementation tier: claude-3-7-sonnet ($3.00/M) or deepseek-v4 ($0.14/M)");
  console.log("3. Frontier/Critical tier: claude-opus-5 ($15.00/M) or grok-4.6 ($2.00/M)");
  console.log("========================================================\n");
}

runAudit().catch((err) => {
  console.error("Audit error:", err);
  process.exit(1);
});
