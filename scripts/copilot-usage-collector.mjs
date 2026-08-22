#!/usr/bin/env node
// Local collector for GitHub Copilot CLI session JSONL.
//
// Reads ~/.copilot/session-state/*/events.jsonl session.shutdown
// modelMetrics (same layout as ccusage). Pushes estimated token events to
// Usage Monitor ingest. Not GitHub org billing. Not cash. Does not open
// ~/.copilot/data.db (that SQLite file holds GitHub tokens).
//
// Usage:
//   node scripts/copilot-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or COPILOT_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   COPILOT_HOME (default ~/.copilot)

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COPILOT_PRODUCER_ID,
  filterEventsSince,
  parseCopilotEventsJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  expandHome,
  parseCollectorArgs,
  readIfFresh,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.COPILOT_PRODUCER_ID || COPILOT_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[copilot-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[copilot-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectCopilotEvents({
  copilotHome = expandHome(process.env.COPILOT_HOME || join(homedir(), ".copilot")),
  since,
} = {}) {
  const root = join(copilotHome, "session-state");
  const files = await walkFiles(root, { name: "events.jsonl" });
  const events = [];
  for (const file of files) {
    const text = await readIfFresh(file);
    if (!text) continue;
    const parsed = parseCopilotEventsJsonl(text, {
      sessionKey: sessionKeyFor(copilotHome, file),
    });
    events.push(...filterEventsSince(parsed, since));
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
  const events = await collectCopilotEvents({ since: args.since });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}`);
  if (DEBUG) {
    const models = new Set(events.map((e) => e.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    return;
  }
  const token =
    process.env.COPILOT_INGEST_TOKEN?.trim() ||
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
