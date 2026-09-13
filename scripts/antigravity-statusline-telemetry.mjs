#!/usr/bin/env node
// Antigravity CLI status-line sink.  Reads the official status JSON on stdin
// and retains only model/token counters when cumulative totals change.  Prompts,
// paths, transcript references, email, quota identity, and tool data are never
// written.  The scheduled session collector forwards these safe snapshots.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root =
  process.env.ANTIGRAVITY_TELEMETRY_STATE_DIR ||
  join(homedir(), ".cache", "usage-monitor", "antigravity-statusline");
const eventLog = join(root, "usage.jsonl");
const captureState = join(root, "capture-state.json");

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const sessionId = String(payload.conversation_id || payload.session_id || "").trim();
  const model = String(payload.model?.id || payload.model?.display_name || "").trim();
  const context = payload.context_window && typeof payload.context_window === "object"
    ? payload.context_window
    : {};
  const usage = context.current_usage && typeof context.current_usage === "object"
    ? context.current_usage
    : {};
  if (!sessionId || !model) return;
  const totalInput = finiteCount(context.total_input_tokens);
  const totalOutput = finiteCount(context.total_output_tokens);
  const breakdown = {
    input: finiteCount(usage.input_tokens),
    output: finiteCount(usage.output_tokens),
    cacheRead: finiteCount(usage.cache_read_input_tokens),
    cacheCreation: finiteCount(usage.cache_creation_input_tokens),
  };
  if (totalInput + totalOutput === 0) return;

  await mkdir(root, { recursive: true });
  let state = {};
  try {
    state = JSON.parse(await readFile(captureState, "utf8"));
  } catch {
    // First observation for this session.
  }
  const sessionHash = hash(sessionId);
  const previous = state[sessionHash];
  const previousInput = previous && typeof previous === "object"
    ? finiteCount(previous.totalInput)
    : 0;
  const previousOutput = previous && typeof previous === "object"
    ? finiteCount(previous.totalOutput)
    : 0;
  const inputDelta = Math.max(0, totalInput - previousInput);
  const outputDelta = Math.max(0, totalOutput - previousOutput);
  const totalSignature = `${totalInput}:${totalOutput}`;
  const previousSignature = typeof previous === "string"
    ? previous
    : `${previousInput}:${previousOutput}`;
  if (previousSignature === totalSignature || inputDelta + outputDelta === 0) return;
  const signature = hash(`${sessionHash}\0${model}\0${totalSignature}`);
  // current_usage describes the current request, while the total fields are
  // cumulative for the conversation.  Use the exact split only when it fully
  // reconciles to the cumulative delta; otherwise retain exact total deltas
  // and mark the cache split unavailable.
  const breakdownComplete =
    breakdown.input + breakdown.cacheRead + breakdown.cacheCreation === inputDelta &&
    breakdown.output === outputDelta;
  const snapshot = {
    type: "antigravity.statusline.usage",
    occurredAt: new Date().toISOString(),
    sessionHash,
    signature,
    model,
    totalInput,
    totalOutput,
    inputDelta,
    outputDelta,
    breakdownComplete,
    usage: breakdownComplete
      ? breakdown
      : { input: inputDelta, output: outputDelta, cacheRead: 0, cacheCreation: 0 },
  };
  await appendFile(eventLog, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  state[sessionHash] = { totalInput, totalOutput };
  const temp = `${captureState}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temp, captureState);
}

main().catch(() => {
  // A status line must never interrupt the coding session.
});
