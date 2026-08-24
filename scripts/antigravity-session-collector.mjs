#!/usr/bin/env node
// Local collector for Google Antigravity IDE session transcripts.
//
// Reads ${ANTIGRAVITY_BRAIN_HOME:-~/.gemini/antigravity/brain}/*/logs/transcript*.jsonl.
// Extracts model overrides, reasoning effort, step tokens (prompts, planner responses, tool buffers).
// Pushes estimated token events to Usage Monitor ingest. Not a billing API. Not cash.
//
// Usage:
//   node scripts/antigravity-session-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or ANTIGRAVITY_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   ANTIGRAVITY_BRAIN_HOME (default ~/.gemini/antigravity/brain)

import { homedir } from "node:os";
import { join } from "node:path";

import {
  ANTIGRAVITY_PRODUCER_ID,
  filterEventsSince,
  parseAntigravityTranscriptJsonl,
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
const PRODUCER_ID = process.env.ANTIGRAVITY_PRODUCER_ID || ANTIGRAVITY_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[antigravity-session-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[antigravity-session-collector] ${message}`);
  process.exit(code);
}

export async function collectAntigravitySessionEvents({
  brainHome = expandHome(process.env.ANTIGRAVITY_BRAIN_HOME || join(homedir(), ".gemini", "antigravity", "brain")),
  since,
} = {}) {
  const files = await walkFiles(brainHome, { name: "transcript.jsonl" });
  const events = [];
  for (const file of files) {
    const text = await readIfFresh(file);
    if (!text) continue;
    const parsed = parseAntigravityTranscriptJsonl(text, {
      sessionKey: sessionKeyFor(brainHome, file),
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
  const events = await collectAntigravitySessionEvents({ since: args.since });
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
    process.env.ANTIGRAVITY_INGEST_TOKEN?.trim() ||
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
    log(
      `done: received=${ack.received} persisted=${ack.persisted} rejected=${ack.rejected}${
        ack.dryRun ? " (dry-run)" : ""
      }`
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
