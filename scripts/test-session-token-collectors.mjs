#!/usr/bin/env node
import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";
import {
  CODEX_PRODUCER_ID,
  COPILOT_PRODUCER_ID,
  GROK_COST_USD_TICKS,
  GROK_PRODUCER_ID,
  chunkEvents,
  parseCodexJsonl,
  parseCopilotEventsJsonl,
  parseGrokUpdatesJsonl,
  splitInclusiveCache,
} from "./lib/session-token-collectors.mjs";

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
}

const split = splitInclusiveCache({
  input: 30297,
  output: 386,
  cacheRead: 9984,
  cacheCreation: 0,
});
assert(split.input === 30297 - 9984, "codex uncached input");
assert(split.cacheRead === 9984, "codex cache read");
assert(split.output === 386, "codex output");

const codexFixture = [
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T12:00:00.000Z",
    payload: { model: "gpt-5.6-sol" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:01.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cached_input_tokens: 200,
          cache_write_input_tokens: 50,
          reasoning_output_tokens: 20,
          total_tokens: 1100,
        },
      },
    },
  }),
].join("\n");

const codexEvents = parseCodexJsonl(codexFixture, { sessionKey: "test/session.jsonl" });
assert(codexEvents.length === 4, `codex event count ${codexEvents.length}`);
assert(
  codexEvents.every((e) => e.producerKeyRef === "gpt-5.6-sol"),
  "codex model from turn_context"
);
assert(
  codexEvents.find((e) => e.label === "token:input")?.quantity === 800,
  "codex uncached input quantity"
);
assert(
  codexEvents.find((e) => e.label === "token:cacheRead")?.quantity === 200,
  "codex cache read quantity"
);
assert(
  codexEvents.find((e) => e.label === "token:cacheCreation")?.quantity === 50,
  "codex cache write quantity"
);
assert(
  new Set(codexEvents.map((e) => e.eventId)).size === codexEvents.length,
  "codex eventIds unique"
);

const lastUsage = {
  input_tokens: 1000,
  output_tokens: 100,
  cached_input_tokens: 200,
  cache_write_input_tokens: 50,
  reasoning_output_tokens: 20,
  total_tokens: 1100,
};
const sameTotal = {
  input_tokens: 1000,
  cached_input_tokens: 200,
  output_tokens: 100,
  cache_write_input_tokens: 50,
  reasoning_output_tokens: 20,
  total_tokens: 1100,
};
const nextTotal = {
  input_tokens: 2500,
  cached_input_tokens: 400,
  output_tokens: 180,
  cache_write_input_tokens: 50,
  reasoning_output_tokens: 30,
  total_tokens: 2680,
};
const replayFixture = [
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T12:00:00.000Z",
    payload: { model: "gpt-5.6-sol" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:01.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: lastUsage, total_token_usage: sameTotal },
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:02.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: lastUsage, total_token_usage: sameTotal },
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:03.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1500,
          output_tokens: 80,
          cached_input_tokens: 200,
          cache_write_input_tokens: 0,
          total_tokens: 1580,
        },
        total_token_usage: nextTotal,
      },
    },
  }),
].join("\n");
const replayEvents = parseCodexJsonl(replayFixture, { sessionKey: "test/replay.jsonl" });
assert(
  replayEvents.length === 7,
  `codex replay skip ${replayEvents.length}`
);
assert(
  replayEvents.filter((e) => e.label === "token:input").reduce((sum, e) => sum + e.quantity, 0) ===
    800 + 1300,
  "codex replay does not double last_token_usage"
);

const grokFixture = JSON.stringify({
  method: "session/update",
  timestamp: "2026-08-01T12:00:00.000Z",
  params: {
    sessionId: "sess-test",
    update: {
      sessionUpdate: "turn_completed",
      usage: {
        inputTokens: 10000,
        outputTokens: 500,
        cachedReadTokens: 2000,
        cacheCreationTokens: 100,
        reasoningTokens: 50,
        totalTokens: 10500,
        costUsdTicks: 2 * GROK_COST_USD_TICKS,
        modelUsage: {
          "grok-4.6-build": {
            inputTokens: 10000,
            outputTokens: 500,
            cachedReadTokens: 2000,
            cacheCreationTokens: 100,
            reasoningTokens: 50,
            totalTokens: 10500,
            costUsdTicks: 2 * GROK_COST_USD_TICKS,
          },
        },
      },
    },
  },
});

const grokEvents = parseGrokUpdatesJsonl(grokFixture, {
  sessionKey: "sessions/cwd/sess/updates.jsonl",
});
const grokTokens = grokEvents.filter((e) => e.metricType === "usage");
const grokCosts = grokEvents.filter((e) => e.metricType === "cost");
assert(grokTokens.length === 4, `grok token events ${grokTokens.length}`);
assert(grokCosts.length === 1, `grok cost events ${grokCosts.length}`);
assert(grokTokens[0].producerKeyRef === "grok-4.6-build", "grok model");
assert(
  grokTokens.find((e) => e.label === "token:input")?.quantity === 8000,
  "grok uncached input"
);
assert(grokCosts[0].costUsd === 2, "grok ticks to usd");
assert(grokEvents.every((e) => e.billingMode === "estimated"), "never cash");

const skipIncomplete = parseGrokUpdatesJsonl(
  JSON.stringify({
    method: "session/update",
    timestamp: "2026-08-01T12:00:00.000Z",
    params: { update: { sessionUpdate: "agent_message_chunk" } },
  }),
  { sessionKey: "x" }
);
assert(skipIncomplete.length === 0, "in-progress grok turns ignored");

const copilotFirst = {
  type: "session.shutdown",
  id: "shut-1",
  timestamp: "2026-08-01T12:00:00.000Z",
  data: {
    modelMetrics: {
      "deepseek-v4-pro": {
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 200,
          cacheWriteTokens: 50,
          reasoningTokens: 40,
        },
      },
    },
  },
};
const copilotReplay = {
  ...copilotFirst,
  id: "shut-2",
  timestamp: "2026-08-01T12:05:00.000Z",
};
const copilotNext = {
  type: "session.shutdown",
  id: "shut-3",
  timestamp: "2026-08-01T12:10:00.000Z",
  data: {
    modelMetrics: {
      "deepseek-v4-pro": {
        inputTokens: 2500,
        outputTokens: 180,
        cacheReadTokens: 400,
        cacheWriteTokens: 50,
      },
    },
  },
};
const copilotEvents = parseCopilotEventsJsonl(
  [JSON.stringify(copilotFirst), JSON.stringify(copilotReplay), JSON.stringify(copilotNext)].join(
    "\n"
  ),
  { sessionKey: "session-state/abc/events.jsonl" }
);
assert(copilotEvents.length === 7, `copilot event count ${copilotEvents.length}`);
assert(
  copilotEvents.every((e) => e.producerKeyRef === "deepseek-v4-pro"),
  "copilot model"
);
assert(
  copilotEvents.filter((e) => e.label === "token:input").reduce((sum, e) => sum + e.quantity, 0) ===
    800 + 1300,
  "copilot shutdown deltas, not cumulative double-count"
);
assert(
  copilotEvents.find((e) => e.label === "token:cacheRead")?.quantity === 200,
  "copilot first cache read"
);
assert(
  copilotEvents.every((e) => e.billingMode === "estimated" && e.provider === "github-copilot"),
  "copilot never cash"
);
assert(
  parseCopilotEventsJsonl(
    JSON.stringify({
      type: "assistant.message",
      data: { outputTokens: 12, model: "gpt-5.4" },
    }),
    { sessionKey: "x" }
  ).length === 0,
  "copilot per-message output is not ingested (would double-count shutdown totals)"
);

const batch = {
  schemaVersion: 2,
  producerId: CODEX_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: codexEvents,
};
const parsed = UsageTelemetryV2BatchSchema.safeParse(batch);
assert(parsed.success, `codex batch schema ${parsed.success ? "" : JSON.stringify(parsed.error)}`);

const grokBatch = {
  schemaVersion: 2,
  producerId: GROK_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: grokEvents,
};
const grokParsed = UsageTelemetryV2BatchSchema.safeParse(grokBatch);
assert(
  grokParsed.success,
  `grok batch schema ${grokParsed.success ? "" : JSON.stringify(grokParsed.error)}`
);

const copilotBatch = {
  schemaVersion: 2,
  producerId: COPILOT_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: copilotEvents,
};
const copilotParsed = UsageTelemetryV2BatchSchema.safeParse(copilotBatch);
assert(
  copilotParsed.success,
  `copilot batch schema ${copilotParsed.success ? "" : JSON.stringify(copilotParsed.error)}`
);

const chunks = chunkEvents(new Array(250).fill(codexEvents[0]));
assert(chunks.length === 3, `chunk count ${chunks.length}`);
assert(chunks[0].length === 100 && chunks[2].length === 50, "chunk sizes");

console.log("ok session-token-collectors");
