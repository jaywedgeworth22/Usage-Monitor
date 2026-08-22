#!/usr/bin/env node
// Local collector for Grok Build CLI session logs.
//
// Reads ${GROK_HOME:-~/.grok}/sessions/**/updates.jsonl turn_completed rows
// (same layout as ccusage). Pushes estimated token events plus Grok's
// costUsdTicks converted to USD. Not SuperGrok billing. Not cash.
//
// Usage:
//   node scripts/grok-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or GROK_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   GROK_HOME (default ~/.grok)

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  GROK_PRODUCER_ID,
  filterEventsSince,
  parseGrokUpdatesJsonl,
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
const PRODUCER_ID = process.env.GROK_PRODUCER_ID || GROK_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[grok-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[grok-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectGrokEvents({
  grokHome = expandHome(process.env.GROK_HOME || join(homedir(), ".grok")),
  since,
} = {}) {
  const root = join(grokHome, "sessions");
  const files = await walkFiles(root, { name: "updates.jsonl" });
  const events = [];
  for (const file of files) {
    const text = await readIfFresh(file, since);
    if (!text) continue;
    const parsed = parseGrokUpdatesJsonl(text, {
      sessionKey: sessionKeyFor(grokHome, file),
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
  const events = await collectGrokEvents({ since: args.since });
  const tokenEvents = events.filter((e) => e.metricType === "usage").length;
  const costEvents = events.filter((e) => e.metricType === "cost").length;
  log(
    `parsed ${events.length} event(s) (${tokenEvents} token, ${costEvents} cost) since ${args.since.toISOString()}`
  );
  if (DEBUG) {
    const models = new Set(events.map((e) => e.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    return;
  }
  const token =
    process.env.GROK_INGEST_TOKEN?.trim() ||
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
