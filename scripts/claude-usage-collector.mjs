#!/usr/bin/env node
// Local collector for Anthropic Claude Code session JSONL.
//
// Reads ${CLAUDE_HOME:-~/.claude}/projects/*/*.jsonl.
// Extracts exact model, input_tokens, output_tokens, cache_read, cache_creation,
// thinking tokens, and speed tier.
// Pushes estimated token events to Usage Monitor ingest. Not a billing API. Not cash.
//
// Usage:
//   node scripts/claude-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or CLAUDE_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   CLAUDE_HOME (default ~/.claude)

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_PRODUCER_ID,
  filterEventsSince,
  parseClaudeSessionJsonl,
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
const PRODUCER_ID = process.env.CLAUDE_PRODUCER_ID || CLAUDE_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[claude-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[claude-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectClaudeEvents({
  claudeHome = expandHome(process.env.CLAUDE_HOME || join(homedir(), ".claude")),
  since,
} = {}) {
  const projectsDir = join(claudeHome, "projects");
  const files = await walkFiles(projectsDir, { suffix: ".jsonl" });
  const events = [];
  for (const file of files) {
    const text = await readIfFresh(file);
    if (!text) continue;
    const parsed = parseClaudeSessionJsonl(text, {
      sessionKey: sessionKeyFor(claudeHome, file),
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
  const events = await collectClaudeEvents({ since: args.since });
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
    process.env.CLAUDE_INGEST_TOKEN?.trim() ||
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
