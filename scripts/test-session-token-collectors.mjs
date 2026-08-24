#!/usr/bin/env node
import { join } from "node:path";
import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";
import {
  ANTIGRAVITY_PRODUCER_ID,
  CLAUDE_PRODUCER_ID,
  CODEX_PRODUCER_ID,
  COPILOT_PRODUCER_ID,
  DEEPSEEK_PRODUCER_ID,
  GROK_COST_USD_TICKS,
  GROK_PRODUCER_ID,
  chunkEvents,
  parseAntigravityTranscriptJsonl,
  parseClaudeSessionJsonl,
  parseCodexJsonl,
  parseCopilotEventsJsonl,
  parseDeepSeekSessionJsonl,
  parseGrokUpdatesJsonl,
  splitInclusiveCache,
} from "./lib/session-token-collectors.mjs";
import {
  codexSessionKeyFor,
  sessionKeyFor,
} from "./lib/run-session-token-collector.mjs";

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

const codexHome = "/Users/jay/.codex";
const rolloutName =
  "rollout-2026-08-22T13-02-51-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl";
const liveRollout = join(codexHome, "sessions", "2026", "08", "22", rolloutName);
const flatArchive = join(codexHome, "archived_sessions", rolloutName);
const nestedArchive = join(codexHome, "archived_sessions", "2026", "08", "22", rolloutName);
assert(
  sessionKeyFor(codexHome, liveRollout) !== sessionKeyFor(codexHome, flatArchive),
  "raw relative keys change after Codex flatten-archive"
);
assert(
  codexSessionKeyFor(codexHome, liveRollout) === `sessions/2026/08/22/${rolloutName}`,
  "live Codex sessionKey"
);
assert(
  codexSessionKeyFor(codexHome, flatArchive) === codexSessionKeyFor(codexHome, liveRollout),
  "flattened archive remaps to the live sessions/YYYY/MM/DD key"
);
assert(
  codexSessionKeyFor(codexHome, nestedArchive) === codexSessionKeyFor(codexHome, liveRollout),
  "nested archive remaps to the same live key"
);
const liveParsed = parseCodexJsonl(codexFixture, {
  sessionKey: codexSessionKeyFor(codexHome, liveRollout),
});
const rawArchiveParsed = parseCodexJsonl(codexFixture, {
  sessionKey: sessionKeyFor(codexHome, flatArchive),
});
const remappedArchiveParsed = parseCodexJsonl(codexFixture, {
  sessionKey: codexSessionKeyFor(codexHome, flatArchive),
});
assert(
  liveParsed[0].eventId !== rawArchiveParsed[0].eventId,
  "path-based sessionKey would persist archive as new events"
);
assert(
  liveParsed[0].eventId === remappedArchiveParsed[0].eventId,
  "normalized archive key is idempotent with the live ingest"
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
    750 + 1300,
  "copilot shutdown deltas, not cumulative double-count"
);
assert(
  copilotEvents.find((e) => e.label === "token:cacheRead")?.quantity === 200,
  "copilot first cache read"
);
const copilotPublished = parseCopilotEventsJsonl(
  JSON.stringify({
    type: "session.shutdown",
    timestamp: "2026-05-07T10:57:19.746Z",
    data: {
      modelMetrics: {
        "claude-opus-4.7": {
          usage: {
            inputTokens: 23399,
            outputTokens: 2994,
            cacheReadTokens: 10069,
            cacheWriteTokens: 13324,
            reasoningTokens: 0,
          },
        },
      },
    },
  }),
  { sessionKey: "ccusage-1174" }
);
const copilotPublishedInput = copilotPublished.find((e) => e.label === "token:input")?.quantity ?? 0;
assert(
  copilotPublishedInput === 6,
  `copilot inputTokens includes cache writes; expected 6 uncached, got ${copilotPublishedInput}`
);
assert(
  copilotPublished.find((e) => e.label === "token:cacheRead")?.quantity === 10069,
  "copilot published cache read"
);
assert(
  copilotPublished.find((e) => e.label === "token:cacheCreation")?.quantity === 13324,
  "copilot published cache write"
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


// Antigravity Transcript Tests
const agFixture = [
  JSON.stringify({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    created_at: "2026-08-20T12:00:00.000Z",
    content: "<USER_REQUEST>Fix the auth bug</USER_REQUEST><USER_SETTINGS_CHANGE>Model Selection from None to Gemini 3.6 Flash (High)</USER_SETTINGS_CHANGE>",
  }),
  JSON.stringify({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    created_at: "2026-08-20T12:00:02.000Z",
    content: "I will check the auth route handler now.",
    tool_calls: [{ name: "view_file", args: { AbsolutePath: "/path/to/auth.ts" } }],
  }),
].join("\n");

const agEvents = parseAntigravityTranscriptJsonl(agFixture, { sessionKey: "test/ag-transcript.jsonl" });
assert(agEvents.length === 2, `ag event count ${agEvents.length}`);
assert(agEvents[0].producerKeyRef === "gemini-3.6-flash", "ag model override parsed");
assert(agEvents[0].label === "token:input", "ag user input token event");
assert(agEvents[1].label === "token:output", "ag planner response token event");
assert(agEvents[0].billingMode === "estimated" && agEvents[0].provider === "google", "ag provider & billing mode");

const agBatch = {
  schemaVersion: 2,
  producerId: ANTIGRAVITY_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: agEvents,
};
assert(UsageTelemetryV2BatchSchema.safeParse(agBatch).success, "ag batch schema valid");

// Claude Code Tests
const claudeFixture = [
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-20T14:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 1500,
        output_tokens: 450,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 200,
        speed: "fast",
        output_tokens_details: { thinking_tokens: 120 },
      },
    },
  }),
].join("\n");

const claudeEvents = parseClaudeSessionJsonl(claudeFixture, { sessionKey: "test/claude-session.jsonl" });
assert(claudeEvents.length === 4, `claude event count ${claudeEvents.length}`);
assert(claudeEvents[0].producerKeyRef === "claude-opus-5", "claude model parsed");
assert(claudeEvents.find((e) => e.label === "token:input")?.quantity === 1200, "claude uncached input quantity");
assert(claudeEvents.find((e) => e.label === "token:cacheRead")?.quantity === 300, "claude cache read quantity");
assert(claudeEvents.find((e) => e.label === "token:cacheCreation")?.quantity === 200, "claude cache write quantity");
assert(claudeEvents.find((e) => e.label === "token:output")?.quantity === 450, "claude output quantity");

const claudeBatch = {
  schemaVersion: 2,
  producerId: CLAUDE_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: claudeEvents,
};
assert(UsageTelemetryV2BatchSchema.safeParse(claudeBatch).success, "claude batch schema valid");

// DeepSeek Tests
const dsFixture = [
  JSON.stringify({
    model: "deepseek-v4-pro",
    timestamp: "2026-08-20T16:00:00.000Z",
    usage: {
      prompt_tokens: 800,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 150,
    },
  }),
].join("\n");

const dsEvents = parseDeepSeekSessionJsonl(dsFixture, { sessionKey: "test/ds-session.jsonl" });
assert(dsEvents.length === 3, `deepseek event count ${dsEvents.length}`);
assert(dsEvents[0].producerKeyRef === "deepseek-v4-pro", "deepseek model parsed");
assert(dsEvents[0].provider === "deepseek", "deepseek provider");

const dsBatch = {
  schemaVersion: 2,
  producerId: DEEPSEEK_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: dsEvents,
};
assert(UsageTelemetryV2BatchSchema.safeParse(dsBatch).success, "deepseek batch schema valid");

console.log("ok session-token-collectors");
