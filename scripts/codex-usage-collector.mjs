#!/usr/bin/env node
// Local collector for OpenAI Codex CLI session JSONL.
//
// Reads ${CODEX_HOME:-~/.codex}/sessions and archived_sessions (same layout
// as ccusage).  Archive flatten-moves the rollout filename; sessionKey is
// remapped to the live sessions/YYYY/MM/DD path so a 15-min re-ingest cannot
// double-count.  Pushes estimated token events to Usage Monitor ingest.
// Not a billing API. Not cash.
//
// Usage:
//   node scripts/codex-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or CODEX_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   CODEX_HOME (default ~/.codex)

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CODEX_PRODUCER_ID,
  filterEventsSince,
  parseCodexJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  observedPlanEvent,
  readCodexObservedPlan,
} from "./lib/codex-observed-plan.mjs";
import {
  codexSessionKeyFor,
  expandHome,
  parseCollectorArgs,
  readIfFresh,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.CODEX_PRODUCER_ID || CODEX_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[codex-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[codex-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectCodexEvents({
  codexHome = expandHome(process.env.CODEX_HOME || join(homedir(), ".codex")),
  since,
} = {}) {
  const roots = ["sessions", "archived_sessions"].map((dir) => join(codexHome, dir));
  const events = [];
  for (const root of roots) {
    const files = await walkFiles(root, { suffix: ".jsonl" });
    for (const file of files) {
      const text = await readIfFresh(file);
      if (!text) continue;
      const parsed = parseCodexJsonl(text, {
        sessionKey: codexSessionKeyFor(codexHome, file),
      });
      events.push(...filterEventsSince(parsed, since));
    }
  }
  return events;
}

async function main() {
  let args;
  try {
    args = parseCollectorArgs(process.argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const events = await collectCodexEvents({ since: args.since });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}`);
  const observed = await readCodexObservedPlan(join(expandHome(process.env.CODEX_HOME || join(homedir(), ".codex")), "auth.json"));
  if (observed?.planType) {
    events.push(
      observedPlanEvent({
        planType: observed.planType,
        occurredAtIso: new Date().toISOString(),
      })
    );
    log(`observed chatgpt_plan_type=${observed.planType}`);
  }
  if (DEBUG) {
    const models = new Set(events.map((e) => e.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    return;
  }
  const token =
    process.env.CODEX_INGEST_TOKEN?.trim() ||
    process.env.USAGE_INGEST_TOKEN?.trim();
  try {
    const ack = await postUsageBatches({
      events,
      ingestUrl: INGEST_URL,
      ingestToken: token,
      producerId: PRODUCER_ID,
      dryRun: DRY || args.dryRun,
      log,
    });
    log(`ingest ack: ${JSON.stringify({ received: ack.received, persisted: ack.persisted, rejected: ack.rejected, dryRun: ack.dryRun ?? false })}`);
    if (ack.rejected > 0) fail(`Ingest reported rejections: ${ack.rejected}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
