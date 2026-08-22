#!/usr/bin/env node
// Parsers for local coding-agent session logs → Usage Monitor ingest events.
//
// Codex: ~/.codex/sessions/**/*.jsonl event_msg/token_count last_token_usage
//   (ccusage Codex data source).  Skip token_count rows whose
//   total_token_usage did not advance — Codex re-emits the previous
//   last_token_usage on rate-limit-only updates (openai/codex#14489,
//   ccusage#876).  Line-numbered eventIds would persist each replay.
// Grok Build: ~/.grok/sessions/**/updates.jsonl sessionUpdate=turn_completed
//   + usage.modelUsage (ccusage Grok data source).
//
// Tokens are posted as billingMode=estimated. Grok costUsdTicks (1e-10 USD)
// are posted as estimated cost events. Neither is cash.

import { createHash } from "node:crypto";
import { hostname } from "node:os";

export const GROK_COST_USD_TICKS = 1e10;
export const MAX_EVENTS_PER_BATCH = 100;

export const CODEX_PRODUCER_ID = "openai-codex";
export const GROK_PRODUCER_ID = "grok-build";

const TOKEN_TYPES = ["input", "output", "cacheRead", "cacheCreation"];

export function splitInclusiveCache({
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
}) {
  const inTok = finiteCount(input);
  const cached = finiteCount(cacheRead);
  const uncached = cached > inTok ? inTok : Math.max(0, inTok - cached);
  return {
    input: uncached,
    output: finiteCount(output),
    cacheRead: cached > inTok ? 0 : cached,
    cacheCreation: finiteCount(cacheCreation),
  };
}

function finiteCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const CODEX_TOTAL_KEYS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
];

function codexTotalSignature(usage) {
  if (!usage || typeof usage !== "object") return null;
  return CODEX_TOTAL_KEYS.map((key) => String(finiteCount(usage[key]))).join("|");
}

function shaEventId(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function isoTimestamp(value, fallbackIso) {
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallbackIso;
}

export function tokenEventsFromBreakdown({
  producerId,
  provider,
  service,
  sessionKey,
  occurredAtIso,
  model,
  breakdown,
  extraId,
}) {
  const events = [];
  for (const tokenType of TOKEN_TYPES) {
    const quantity = breakdown[tokenType];
    if (!quantity) continue;
    events.push({
      eventId: shaEventId([
        producerId,
        sessionKey,
        extraId ?? occurredAtIso,
        model ?? "",
        tokenType,
        String(quantity),
      ]),
      provider,
      service,
      producerKeyRef: model || undefined,
      label: `token:${tokenType}`,
      metricType: "usage",
      unit: "token",
      quantity,
      billingMode: "estimated",
      confidence: "estimated",
      occurredAt: occurredAtIso,
      metadata: {
        tokenType,
        ...(model ? { model } : {}),
      },
    });
  }
  return events;
}

export function estimatedCostEvent({
  producerId,
  provider,
  service,
  sessionKey,
  occurredAtIso,
  model,
  costUsd,
  extraId,
}) {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return {
    eventId: shaEventId([
      producerId,
      sessionKey,
      extraId ?? occurredAtIso,
      model ?? "",
      "cost",
      costUsd.toFixed(10),
    ]),
    provider,
    service,
    producerKeyRef: model || undefined,
    label: "api-equivalent",
    metricType: "cost",
    unit: "usd",
    costUsd,
    billingMode: "estimated",
    confidence: "estimated",
    occurredAt: occurredAtIso,
    metadata: {
      ...(model ? { model } : {}),
    },
  };
}

export function parseCodexJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  let lastModel = null;
  let lastTotalSignature = null;
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : {};
    const payloadModel =
      typeof payload.model === "string"
        ? payload.model
        : typeof payload.model_provider === "string" && typeof payload.model === "string"
          ? payload.model
          : null;
    if (obj.type === "turn_context" || obj.type === "session_meta") {
      const model =
        (typeof payload.model === "string" && payload.model.trim()) ||
        (typeof obj.model === "string" && obj.model.trim()) ||
        null;
      if (model) lastModel = model;
    }
    if (typeof payloadModel === "string" && payloadModel.trim()) {
      lastModel = payloadModel.trim();
    }
    if (obj.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = payload.info && typeof payload.info === "object" ? payload.info : {};
    const last = info.last_token_usage;
    if (!last || typeof last !== "object") continue;
    const totalSignature = codexTotalSignature(info.total_token_usage);
    if (totalSignature && totalSignature === lastTotalSignature) continue;
    if (totalSignature) lastTotalSignature = totalSignature;
    const model =
      (typeof info.model === "string" && info.model.trim()) || lastModel;
    const occurredAtIso = isoTimestamp(obj.timestamp ?? payload.timestamp, fallbackIso);
    const breakdown = splitInclusiveCache({
      input: last.input_tokens,
      output: last.output_tokens,
      cacheRead: last.cached_input_tokens,
      cacheCreation: last.cache_write_input_tokens,
    });
    events.push(
      ...tokenEventsFromBreakdown({
        producerId: CODEX_PRODUCER_ID,
        provider: "openai",
        service: "codex-cli",
        sessionKey: sessionKey ?? "codex",
        occurredAtIso,
        model,
        breakdown,
        extraId: `L${lineNo}`,
      })
    );
  }
  return events;
}

function grokUsageFromUpdate(update) {
  if (!update || typeof update !== "object") return [];
  const usage = update.usage;
  if (!usage || typeof usage !== "object") return [];
  const modelUsage = usage.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    return Object.entries(modelUsage).map(([model, row]) => ({
      model,
      usage: row && typeof row === "object" ? row : {},
    }));
  }
  return [{ model: null, usage }];
}

export function parseGrokUpdatesJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const method = obj.method;
    if (method !== "session/update" && method !== "_x.ai/session/update") continue;
    const params = obj.params && typeof obj.params === "object" ? obj.params : {};
    const update = params.update && typeof params.update === "object" ? params.update : {};
    if (update.sessionUpdate !== "turn_completed") continue;
    const occurredAtIso = isoTimestamp(obj.timestamp, fallbackIso);
    const rows = grokUsageFromUpdate(update);
    for (const { model, usage } of rows) {
      const breakdown = splitInclusiveCache({
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cachedReadTokens,
        cacheCreation: usage.cacheCreationTokens,
      });
      events.push(
        ...tokenEventsFromBreakdown({
          producerId: GROK_PRODUCER_ID,
          provider: "xai",
          service: "grok-cli",
          sessionKey: sessionKey ?? "grok",
          occurredAtIso,
          model,
          breakdown,
          extraId: `L${lineNo}:${model ?? "_"}`,
        })
      );
      const ticks = Number(usage.costUsdTicks);
      const costUsd =
        Number.isFinite(ticks) && ticks > 0 ? ticks / GROK_COST_USD_TICKS : 0;
      const costEvent = estimatedCostEvent({
        producerId: GROK_PRODUCER_ID,
        provider: "xai",
        service: "grok-cli",
        sessionKey: sessionKey ?? "grok",
        occurredAtIso,
        model,
        costUsd,
        extraId: `L${lineNo}:${model ?? "_"}:cost`,
      });
      if (costEvent) events.push(costEvent);
    }
  }
  return events;
}

export function chunkEvents(events, size = MAX_EVENTS_PER_BATCH) {
  const chunks = [];
  for (let i = 0; i < events.length; i += size) {
    chunks.push(events.slice(i, i + size));
  }
  return chunks;
}

export function filterEventsSince(events, since) {
  if (!since) return events;
  const t = since.getTime();
  return events.filter((event) => {
    const at = Date.parse(event.occurredAt);
    return Number.isFinite(at) && at >= t;
  });
}

export async function postUsageBatches({
  events,
  ingestUrl,
  ingestToken,
  producerId,
  dryRun = false,
  log = console.log,
}) {
  const bodyFor = (batch) => ({
    schemaVersion: 2,
    producerId,
    producerInstanceId: hostname(),
    events: batch,
  });
  if (dryRun) {
    log(`--dry-run; would send ${events.length} event(s) as ${chunkEvents(events).length} batch(es)`);
    return { received: 0, persisted: 0, rejected: 0, dryRun: true, events };
  }
  if (!ingestToken) {
    throw new Error("Missing ingest token");
  }
  let received = 0;
  let persisted = 0;
  let rejected = 0;
  for (const batch of chunkEvents(events)) {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-usage-telemetry-version": "2",
        authorization: `Bearer ${ingestToken}`,
      },
      body: JSON.stringify(bodyFor(batch)),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok && response.status !== 202) {
      throw new Error(
        `Ingest rejected the batch (HTTP ${response.status}): ${
          parsed ? JSON.stringify(parsed) : text
        }`
      );
    }
    received += Number(parsed?.received ?? batch.length);
    persisted += Number(parsed?.persisted ?? 0);
    rejected += Number(parsed?.rejected ?? 0);
  }
  return { received, persisted, rejected };
}
