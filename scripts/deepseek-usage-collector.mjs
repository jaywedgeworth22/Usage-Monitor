#!/usr/bin/env node
// Local collector for DeepSeek Harness (DSH) session archives.
//
// Reads ~/.dsh/sessions/**/session.jsonl.zstd assistant/message records and
// sends exact input/output/cache-read token counts plus model attribution.
// BotFleet-managed child sessions can be excluded after BotFleet's durable
// sender is deployed.  API-equivalent analytics only.
//
// Usage:
//   node scripts/deepseek-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]

// Env:
//   USAGE_INGEST_TOKEN or DEEPSEEK_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   DSH_HOME (default ~/.dsh)
//   ZSTD_BIN (default /opt/homebrew/bin/zstd)


import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DEEPSEEK_PRODUCER_ID,
  filterEventsSince,
  parseDeepSeekSessionJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  botFleetChildExclusionEnabled,
  canAdvanceCollectorCheckpoint,
  expandHome,
  isBotFleetSessionPath,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const execFileAsync = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.DEEPSEEK_PRODUCER_ID || DEEPSEEK_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[deepseek-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[deepseek-usage-collector] ${message}`);
  process.exit(code);
}

async function decompress(path) {
  const zstdBin = process.env.ZSTD_BIN || "/opt/homebrew/bin/zstd";
  const { stdout } = await execFileAsync(zstdBin, ["-dc", path], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

export async function collectDeepSeekEvents({
  dshHome = expandHome(process.env.DSH_HOME || join(homedir(), ".dsh")),
  since,
  scanStatus,
} = {}) {
  const root = join(dshHome, "sessions");
  const files = await walkFiles(root, { name: "session.jsonl.zstd" });
  const events = [];
  for (const file of files) {
    if (botFleetChildExclusionEnabled() && isBotFleetSessionPath(file)) continue;
    try {
      const fileStat = await stat(file);
      if (since && fileStat.mtime < since) continue;
      const text = await decompress(file);
      const parsed = parseDeepSeekSessionJsonl(text, {
        sessionKey: sessionKeyFor(dshHome, file),
      });
      events.push(...filterEventsSince(parsed, since));
    } catch (error) {
      if (scanStatus) scanStatus.complete = false;
      if (DEBUG) log(`skipped unreadable archive (${error instanceof Error ? error.name : "error"})`);
    }
  }
  return events;
}

async function main() {
  const passStartedAt = new Date();
  let args;
  try {
    args = await resolveCollectorArgs(process.argv, PRODUCER_ID, { now: passStartedAt });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const scanStatus = { complete: true };
  const events = await collectDeepSeekEvents({ since: args.since, scanStatus });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`);
  if (DEBUG) {
    const models = new Set(events.map((event) => event.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken([
    "DEEPSEEK_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ]);
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
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
