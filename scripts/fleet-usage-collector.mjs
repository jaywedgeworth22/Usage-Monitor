#!/usr/bin/env node
// Master unified fleet usage collector for ALL coding agent seats:
// - Google Antigravity (Live Quota Windows + Session Transcripts)
// - Anthropic Claude Code & Monet (~/.claude/projects/)
// - OpenAI Codex CLI (~/.codex/sessions)
// - Grok Build (~/.grok/sessions)
// - GitHub Copilot CLI (~/.copilot/session-state)
// - DeepSeek Harness (~/.dsh/sessions)
//
// Pushes quota & token telemetry to Usage Monitor (https://usage.jays.services).
//
// Usage:
//   node scripts/fleet-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]

import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  ANTIGRAVITY_PRODUCER_ID,
  CLAUDE_PRODUCER_ID,
  CODEX_PRODUCER_ID,
  COPILOT_PRODUCER_ID,
  DEEPSEEK_PRODUCER_ID,
  GROK_PRODUCER_ID,
  filterEventsSince,
  parseAntigravityTranscriptJsonl,
  parseClaudeSessionJsonl,
  parseCodexJsonl,
  parseCopilotEventsJsonl,
  parseDeepSeekSessionJsonl,
  parseGrokUpdatesJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  codexSessionKeyFor,
  expandHome,
  parseCollectorArgs,
  readIfFresh,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[fleet-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[fleet-usage-collector] ${message}`);
  process.exit(code);
}

// 1. Antigravity Quota
async function collectAntigravityQuota() {
  const cliBin = process.env.ANTIGRAVITY_CLI_BIN || "agy";
  try {
    const raw = execFileSync(cliBin, ["-p", "/usage", "--output-format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    const parsed = JSON.parse(raw);
    const groups = parsed?.command?.data?.groups || [];
    const events = [];
    for (const group of groups) {
      for (const bucket of group.buckets || []) {
        const remainingPct = (bucket.remaining_fraction ?? 1) * 100;
        events.push({
          eventId: `agy-quota:${bucket.id}:${bucket.reset_time}`,
          provider: "google-antigravity",
          service: "antigravity-cli",
          label: `${group.name} (${bucket.window || "window"})`,
          metricType: "quota",
          billingMode: "actual",
          confidence: "actual",
          limit: 100,
          credits: Number(remainingPct.toFixed(2)),
          occurredAt: new Date().toISOString(),
          metadata: {
            modelGroup: group.name,
            bucketId: bucket.id,
            quotaWindow: bucket.window,
            resetAt: bucket.reset_time,
            scale: "percent_0_100",
            rawPercentUsed: Number((100 - remainingPct).toFixed(2)),
          },
        });
      }
    }
    return events;
  } catch (error) {
    if (DEBUG) log(`Antigravity quota read skipped: ${error.message}`);
    return [];
  }
}

// 2. All Agent Session Transcripts
async function collectAllSessionEvents(since) {
  const results = {
    antigravity: [],
    claude: [],
    codex: [],
    grok: [],
    copilot: [],
    deepseek: [],
  };

  // Antigravity transcripts
  const agBrain = expandHome("~/.gemini/antigravity/brain");
  const agFiles = await walkFiles(agBrain, { name: "transcript.jsonl" });
  for (const f of agFiles) {
    const text = await readIfFresh(f);
    if (!text) continue;
    results.antigravity.push(...filterEventsSince(parseAntigravityTranscriptJsonl(text, { sessionKey: sessionKeyFor(agBrain, f) }), since));
  }

  // Claude Code
  const claudeHome = expandHome("~/.claude");
  const claudeFiles = await walkFiles(join(claudeHome, "projects"), { suffix: ".jsonl" });
  for (const f of claudeFiles) {
    const text = await readIfFresh(f);
    if (!text) continue;
    results.claude.push(...filterEventsSince(parseClaudeSessionJsonl(text, { sessionKey: sessionKeyFor(claudeHome, f) }), since));
  }

  // OpenAI Codex
  const codexHome = expandHome("~/.codex");
  for (const root of ["sessions", "archived_sessions"].map((d) => join(codexHome, d))) {
    const codexFiles = await walkFiles(root, { suffix: ".jsonl" });
    for (const f of codexFiles) {
      const text = await readIfFresh(f);
      if (!text) continue;
      results.codex.push(...filterEventsSince(parseCodexJsonl(text, { sessionKey: codexSessionKeyFor(codexHome, f) }), since));
    }
  }

  // Grok Build
  const grokHome = expandHome("~/.grok");
  const grokFiles = await walkFiles(join(grokHome, "sessions"), { name: "updates.jsonl" });
  for (const f of grokFiles) {
    const text = await readIfFresh(f);
    if (!text) continue;
    results.grok.push(...filterEventsSince(parseGrokUpdatesJsonl(text, { sessionKey: sessionKeyFor(grokHome, f) }), since));
  }

  // GitHub Copilot
  const copilotHome = expandHome("~/.copilot");
  const copilotFiles = await walkFiles(join(copilotHome, "session-state"), { name: "events.jsonl" });
  for (const f of copilotFiles) {
    const text = await readIfFresh(f);
    if (!text) continue;
    results.copilot.push(...filterEventsSince(parseCopilotEventsJsonl(text, { sessionKey: sessionKeyFor(copilotHome, f) }), since));
  }

  // DeepSeek
  const dshHome = expandHome("~/.dsh");
  const dshFiles = await walkFiles(join(dshHome, "sessions"), { suffix: ".jsonl" });
  for (const f of dshFiles) {
    const text = await readIfFresh(f);
    if (!text) continue;
    results.deepseek.push(...filterEventsSince(parseDeepSeekSessionJsonl(text, { sessionKey: sessionKeyFor(dshHome, f) }), since));
  }

  return results;
}

/**
 * v2 ingest maps sourceApp and the idempotency key from the *batch*
 * producerId (hash(producerId, eventId)).  Posting every seat as
 * `fleet-usage-collector` therefore:
 *   - misses SUBSCRIPTION_ANALYTICS_SOURCE_APPS (claude-code / grok-build /
 *     openai-codex / antigravity-cli / github-copilot), so Grok costUsdTicks
 *     land on the cash/pushed-usage path instead of estimatedApiEquivalentUsd
 *   - cannot dedupe against the per-seat LaunchAgents, so a dual install
 *     persists the same tokens twice
 * Keep one batch per seat producer id so eventIds already hashed with those
 * ids stay idempotent with the individual collectors.
 */
export function fleetIngestJobs({ quotaEvents = [], sessionResults = {} } = {}) {
  return [
    {
      producerId: ANTIGRAVITY_PRODUCER_ID,
      events: [...quotaEvents, ...(sessionResults.antigravity ?? [])],
    },
    { producerId: CLAUDE_PRODUCER_ID, events: sessionResults.claude ?? [] },
    { producerId: CODEX_PRODUCER_ID, events: sessionResults.codex ?? [] },
    { producerId: GROK_PRODUCER_ID, events: sessionResults.grok ?? [] },
    { producerId: COPILOT_PRODUCER_ID, events: sessionResults.copilot ?? [] },
    { producerId: DEEPSEEK_PRODUCER_ID, events: sessionResults.deepseek ?? [] },
  ].filter((job) => job.events.length > 0);
}

async function main() {
  let args;
  try {
    args = parseCollectorArgs(process.argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  log(`Starting fleet collection pass (since ${args.since.toISOString()})...`);

  // Collect Quota
  const quotaEvents = await collectAntigravityQuota();
  log(`Quota events collected: ${quotaEvents.length}`);

  // Collect Sessions
  const sessionResults = await collectAllSessionEvents(args.since);
  const totalSessionEvents =
    sessionResults.antigravity.length +
    sessionResults.claude.length +
    sessionResults.codex.length +
    sessionResults.grok.length +
    sessionResults.copilot.length +
    sessionResults.deepseek.length;

  log(`Session token events collected: ${totalSessionEvents}`);
  log(`  - Antigravity: ${sessionResults.antigravity.length}`);
  log(`  - Claude Code: ${sessionResults.claude.length}`);
  log(`  - OpenAI Codex: ${sessionResults.codex.length}`);
  log(`  - Grok Build: ${sessionResults.grok.length}`);
  log(`  - Copilot CLI: ${sessionResults.copilot.length}`);
  log(`  - DeepSeek: ${sessionResults.deepseek.length}`);

  const jobs = fleetIngestJobs({ quotaEvents, sessionResults });

  if (jobs.length === 0) {
    log("Nothing to send.");
    return;
  }

  const token =
    process.env.USAGE_INGEST_TOKEN?.trim() ||
    process.env.ANTIGRAVITY_INGEST_TOKEN?.trim() ||
    process.env.CLAUDE_INGEST_TOKEN?.trim();

  try {
    let received = 0;
    let persisted = 0;
    let rejected = 0;
    let dryRun = false;
    for (const job of jobs) {
      const ack = await postUsageBatches({
        events: job.events,
        ingestUrl: INGEST_URL,
        ingestToken: token,
        producerId: job.producerId,
        dryRun: DRY || args.dryRun,
        log,
      });
      received += ack.received;
      persisted += ack.persisted;
      rejected += ack.rejected;
      dryRun = dryRun || Boolean(ack.dryRun);
    }
    log(
      `Pass complete: received=${received} persisted=${persisted} rejected=${rejected}${
        dryRun ? " (dry-run)" : ""
      }`
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// Entrypoint detection compares the RESOLVED module URL, not a suffix.
// `import.meta.url` percent-encodes the path while `process.argv[1]` does not,
// so `.endsWith(process.argv[1])` is FALSE for any checkout whose path contains
// a space (or #, ?, %) -- and this fleet has such paths. The failure is silent:
// the CLI body is skipped, nothing is collected, and the process exits 0, so a
// LaunchAgent reports success forever while telemetry quietly stops arriving.
// This is the idiom the other collectors in scripts/ already use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
