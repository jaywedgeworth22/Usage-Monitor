import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_PRODUCER_ID,
  CLAUDE_PRODUCER_ID,
  CODEX_PRODUCER_ID,
  COPILOT_PRODUCER_ID,
  CURSOR_PRODUCER_ID,
  DEEPSEEK_PRODUCER_ID,
  GROK_COST_USD_TICKS,
  GROK_PRODUCER_ID,
  MAX_EVENTS_PER_BATCH,
  chunkEvents,
  estimatedCostEvent,
  filterEventsSince,
  parseAntigravityTranscriptJsonl,
  parseClaudeSessionJsonl,
  parseCodexJsonl,
  parseCopilotEventsJsonl,
  parseCursorSessionJsonl,
  parseDeepSeekSessionJsonl,
  parseGrokUpdatesJsonl,
  postUsageBatches,
  splitInclusiveCache,
  tokenEventsFromBreakdown,
} from "../lib/session-token-collectors.mjs";

describe("splitInclusiveCache", () => {
  it("subtracts cache reads from an inclusive input count", () => {
    const out = splitInclusiveCache({ input: 30297, output: 386, cacheRead: 9984, cacheCreation: 0 });
    expect(out.input).toBe(30297 - 9984);
    expect(out.cacheRead).toBe(9984);
    expect(out.output).toBe(386);
    expect(out.cacheCreation).toBe(0);
  });

  it("defaults every field when called with an empty object", () => {
    const out = splitInclusiveCache({});
    expect(out).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it("treats undefined, zero and negative-ish inputs as zero", () => {
    expect(splitInclusiveCache({ input: undefined, output: -5, cacheRead: 0, cacheCreation: -1 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });

  it("clamps cacheRead to input (as the whole inclusive count) when cache exceeds it", () => {
    const out = splitInclusiveCache({ input: 100, output: 1, cacheRead: 500, cacheCreation: 3 });
    expect(out.input).toBe(100);
    expect(out.cacheRead).toBe(0);
    expect(out.cacheCreation).toBe(3);
  });

  it("coerces numeric strings and ignores non-numeric strings", () => {
    const out = splitInclusiveCache({ input: "200", output: "not-a-number", cacheRead: "50", cacheCreation: "10" });
    expect(out.input).toBe(150);
    expect(out.output).toBe(0);
    expect(out.cacheRead).toBe(50);
    expect(out.cacheCreation).toBe(10);
  });
});

describe("tokenEventsFromBreakdown", () => {
  const base = {
    producerId: "test-producer",
    provider: "test",
    service: "test-cli",
    sessionKey: "session-1",
    occurredAtIso: "2026-08-01T00:00:00.000Z",
  };

  it("emits one event per non-zero token type and skips zero components", () => {
    const events = tokenEventsFromBreakdown({
      ...base,
      model: "model-a",
      breakdown: { input: 10, output: 0, cacheRead: 5, cacheCreation: 0 },
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.label).sort()).toEqual(["token:cacheRead", "token:input"]);
    expect(events.every((e) => e.metadata.model === "model-a")).toBe(true);
    expect(events.every((e) => e.producerKeyRef === "model-a")).toBe(true);
  });

  it("emits nothing when every component is zero", () => {
    const events = tokenEventsFromBreakdown({
      ...base,
      model: "model-a",
      breakdown: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(events).toHaveLength(0);
  });

  it("handles a null model by omitting producerKeyRef and metadata.model", () => {
    const events = tokenEventsFromBreakdown({
      ...base,
      model: null,
      breakdown: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(events).toHaveLength(1);
    expect(events[0].producerKeyRef).toBeUndefined();
    expect(events[0].metadata).toEqual({ tokenType: "input" });
  });

  it("handles a null sessionKey without throwing and still produces a stable eventId", () => {
    const events = tokenEventsFromBreakdown({
      ...base,
      sessionKey: null,
      model: "model-a",
      breakdown: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(events).toHaveLength(1);
    expect(typeof events[0].eventId).toBe("string");
    expect(events[0].eventId.length).toBeGreaterThan(0);
  });

  it("uses extraId over occurredAtIso when present, keeping eventIds distinct per line", () => {
    const a = tokenEventsFromBreakdown({
      ...base,
      model: "model-a",
      breakdown: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
      extraId: "L1",
    });
    const b = tokenEventsFromBreakdown({
      ...base,
      model: "model-a",
      breakdown: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
      extraId: "L2",
    });
    expect(a[0].eventId).not.toBe(b[0].eventId);
  });
});

describe("estimatedCostEvent", () => {
  const base = {
    producerId: "test-producer",
    provider: "test",
    service: "test-cli",
    sessionKey: "session-1",
    occurredAtIso: "2026-08-01T00:00:00.000Z",
    model: "model-a",
  };

  it("returns null for a zero cost", () => {
    expect(estimatedCostEvent({ ...base, costUsd: 0 })).toBeNull();
  });

  it("returns null for a non-finite cost", () => {
    expect(estimatedCostEvent({ ...base, costUsd: NaN })).toBeNull();
    expect(estimatedCostEvent({ ...base, costUsd: Infinity })).toBeNull();
  });

  it("returns null for a negative cost", () => {
    expect(estimatedCostEvent({ ...base, costUsd: -1 })).toBeNull();
  });

  it("builds a cost event for a positive cost", () => {
    const event = estimatedCostEvent({ ...base, costUsd: 1.5 });
    expect(event).not.toBeNull();
    expect(event.metricType).toBe("cost");
    expect(event.costUsd).toBe(1.5);
    expect(event.billingMode).toBe("estimated");
    expect(event.metadata.model).toBe("model-a");
  });

  it("omits metadata.model when model is null", () => {
    const event = estimatedCostEvent({ ...base, model: null, costUsd: 1 });
    expect(event.metadata).toEqual({});
    expect(event.producerKeyRef).toBeUndefined();
  });
});

describe("parseCodexJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseCodexJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseCodexJsonl("not json at all", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseCodexJsonl("[1,2,3]", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a well-formed JSON line of the wrong shape", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "something_else" }), { sessionKey: "s" })).toEqual([]);
  });

  it("skips a token_count event missing last_token_usage", () => {
    const line = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T00:00:00.000Z",
      payload: { type: "token_count", info: {} },
    });
    expect(parseCodexJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("parses a well-formed token_count line and carries the turn_context model forward", () => {
    const fixture = [
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
            },
          },
        },
      }),
    ].join("\n");
    const events = parseCodexJsonl(fixture, { sessionKey: "test/session.jsonl" });
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.producerKeyRef === "gpt-5.6-sol")).toBe(true);
    expect(events.find((e) => e.label === "token:input")?.quantity).toBe(800);
  });

  it("dedupes consecutive lines with the same total_token_usage signature", () => {
    const lastUsage = {
      input_tokens: 1000,
      output_tokens: 100,
      cached_input_tokens: 200,
      cache_write_input_tokens: 50,
    };
    const sameTotal = {
      input_tokens: 1000,
      cached_input_tokens: 200,
      output_tokens: 100,
      cache_write_input_tokens: 50,
    };
    const nextTotal = { input_tokens: 2500, cached_input_tokens: 400, output_tokens: 180, cache_write_input_tokens: 50 };
    const fixture = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T12:00:00.000Z",
        payload: { model: "gpt-5.6-sol" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T12:00:01.000Z",
        payload: { type: "token_count", info: { last_token_usage: lastUsage, total_token_usage: sameTotal } },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T12:00:02.000Z",
        payload: { type: "token_count", info: { last_token_usage: lastUsage, total_token_usage: sameTotal } },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T12:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1500, output_tokens: 80, cached_input_tokens: 200, cache_write_input_tokens: 0 },
            total_token_usage: nextTotal,
          },
        },
      }),
    ].join("\n");
    const events = parseCodexJsonl(fixture, { sessionKey: "test/replay.jsonl" });
    // First token_count line emits 4 events (input/output/cacheRead/cacheCreation),
    // second is a dupe signature and skipped, third differs and emits 3 (no cache write).
    expect(events).toHaveLength(7);
  });

  it("falls back to info.model when present, and to the carried-forward model when info.model is absent", () => {
    const withInfoModel = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T12:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          model: "gpt-explicit",
          last_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 },
        },
      },
    });
    const events = parseCodexJsonl(withInfoModel, { sessionKey: "s" });
    expect(events[0].producerKeyRef).toBe("gpt-explicit");

    const withoutModelAtAll = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T12:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 },
        },
      },
    });
    const noModelEvents = parseCodexJsonl(withoutModelAtAll, { sessionKey: "s" });
    expect(noModelEvents[0].producerKeyRef).toBeUndefined();
  });

  it("uses a default fallback timestamp when neither fallbackOccurredAt nor obj.timestamp is usable", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 },
        },
      },
    });
    const events = parseCodexJsonl(line, { sessionKey: "s" });
    expect(events[0].occurredAt).toBe(new Date(0).toISOString());
  });
});

describe("parseGrokUpdatesJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseGrokUpdatesJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseGrokUpdatesJsonl("not json", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseGrokUpdatesJsonl("[]", { sessionKey: "s" })).toEqual([]);
  });

  it("skips an unrelated method", () => {
    const line = JSON.stringify({ method: "session/other", params: {} });
    expect(parseGrokUpdatesJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("skips a sessionUpdate that is not turn_completed", () => {
    const line = JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk" } },
    });
    expect(parseGrokUpdatesJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("accepts the _x.ai/session/update method name", () => {
    const line = JSON.stringify({
      method: "_x.ai/session/update",
      timestamp: "2026-08-01T12:00:00.000Z",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0, cacheCreationTokens: 0 },
        },
      },
    });
    const events = parseGrokUpdatesJsonl(line, { sessionKey: "s" });
    expect(events.some((e) => e.metricType === "usage")).toBe(true);
  });

  it("splits into per-model events when modelUsage is present", () => {
    const line = JSON.stringify({
      method: "session/update",
      timestamp: "2026-08-01T12:00:00.000Z",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 10000,
            outputTokens: 500,
            cachedReadTokens: 2000,
            cacheCreationTokens: 100,
            costUsdTicks: 2 * GROK_COST_USD_TICKS,
            modelUsage: {
              "grok-4.6-build": {
                inputTokens: 10000,
                outputTokens: 500,
                cachedReadTokens: 2000,
                cacheCreationTokens: 100,
                costUsdTicks: 2 * GROK_COST_USD_TICKS,
              },
            },
          },
        },
      },
    });
    const events = parseGrokUpdatesJsonl(line, { sessionKey: "sessions/cwd/sess/updates.jsonl" });
    const tokens = events.filter((e) => e.metricType === "usage");
    const costs = events.filter((e) => e.metricType === "cost");
    expect(tokens).toHaveLength(4);
    expect(costs).toHaveLength(1);
    expect(tokens[0].producerKeyRef).toBe("grok-4.6-build");
    expect(tokens.find((e) => e.label === "token:input")?.quantity).toBe(8000);
    expect(costs[0].costUsd).toBe(2);
  });

  it("falls back to the single top-level usage row when modelUsage is absent", () => {
    const line = JSON.stringify({
      method: "session/update",
      timestamp: "2026-08-01T12:00:00.000Z",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          usage: { inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
        },
      },
    });
    const events = parseGrokUpdatesJsonl(line, { sessionKey: "s" });
    expect(events.some((e) => e.producerKeyRef === undefined)).toBe(true);
  });

  it("treats a zero costUsdTicks and an absent costUsdTicks the same: no cost event", () => {
    const zeroTicks = JSON.stringify({
      method: "session/update",
      timestamp: "2026-08-01T12:00:00.000Z",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          usage: { inputTokens: 10, outputTokens: 1, costUsdTicks: 0 },
        },
      },
    });
    const absentTicks = JSON.stringify({
      method: "session/update",
      timestamp: "2026-08-01T12:00:00.000Z",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          usage: { inputTokens: 10, outputTokens: 1 },
        },
      },
    });
    expect(parseGrokUpdatesJsonl(zeroTicks, { sessionKey: "s" }).some((e) => e.metricType === "cost")).toBe(false);
    expect(parseGrokUpdatesJsonl(absentTicks, { sessionKey: "s" }).some((e) => e.metricType === "cost")).toBe(false);
  });
});

describe("parseClaudeSessionJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseClaudeSessionJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseClaudeSessionJsonl("garbage", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseClaudeSessionJsonl("null", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line with no usage object", () => {
    expect(parseClaudeSessionJsonl(JSON.stringify({ type: "assistant" }), { sessionKey: "s" })).toEqual([]);
  });

  it("parses a well-formed line, defaulting the model when absent", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T14:00:00.000Z",
      message: {
        usage: {
          input_tokens: 1500,
          output_tokens: 450,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 200,
        },
      },
    });
    const events = parseClaudeSessionJsonl(line, { sessionKey: "test/claude-session.jsonl" });
    expect(events).toHaveLength(4);
    expect(events[0].producerKeyRef).toBe("claude-3-7-sonnet");
    expect(events.find((e) => e.label === "token:input")?.quantity).toBe(1200);
  });

  it("reads usage from a top-level obj.usage as a fallback", () => {
    const line = JSON.stringify({
      timestamp: "2026-08-20T14:00:00.000Z",
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const events = parseClaudeSessionJsonl(line, { sessionKey: "s" });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("parseAntigravityTranscriptJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseAntigravityTranscriptJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseAntigravityTranscriptJsonl("garbage", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseAntigravityTranscriptJsonl("42", { sessionKey: "s" })).toEqual([]);
  });

  it("emits nothing for a step type that produces zero tokens", () => {
    const line = JSON.stringify({ type: "OTHER_STEP", created_at: "2026-08-20T12:00:00.000Z", content: "" });
    expect(parseAntigravityTranscriptJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("parses a model-selection USER_INPUT line and a PLANNER_RESPONSE with tool calls", () => {
    const fixture = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-08-20T12:00:00.000Z",
        content:
          "<USER_REQUEST>Fix the auth bug</USER_REQUEST><USER_SETTINGS_CHANGE>Model Selection from None to Gemini 3.6 Flash (High)</USER_SETTINGS_CHANGE>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-08-20T12:00:02.000Z",
        content: "I will check the auth route handler now.",
        tool_calls: [{ name: "view_file", args: { AbsolutePath: "/path/to/auth.ts" } }],
      }),
    ].join("\n");
    const events = parseAntigravityTranscriptJsonl(fixture, { sessionKey: "test/ag-transcript.jsonl" });
    expect(events).toHaveLength(2);
    expect(events[0].producerKeyRef).toBe("gemini-3.6-flash");
    expect(events[0].label).toBe("token:input");
    expect(events[1].label).toBe("token:output");
  });

  it("recognizes every model-selection alias and every effort tag", () => {
    const models = [
      ["Gemini 3.7 Flash", "gemini-3.7-flash"],
      ["Gemini 2.5 Pro", "gemini-2.5-pro"],
      ["Claude 3.5 Sonnet", "claude-3-5-sonnet"],
      ["Claude 3.7 Sonnet", "claude-3-7-sonnet"],
      ["gpt-4o", "gpt-4o"],
    ];
    for (const [label, expected] of models) {
      const line = JSON.stringify({
        type: "USER_INPUT",
        created_at: "2026-08-20T12:00:00.000Z",
        content: `<USER_SETTINGS_CHANGE>Model Selection from None to ${label} (Low)</USER_SETTINGS_CHANGE>`,
      });
      const events = parseAntigravityTranscriptJsonl(line, { sessionKey: "s" });
      expect(events[0].producerKeyRef).toBe(expected);
    }
  });

  it("emits input tokens for GENERIC and SYSTEM_MESSAGE step types", () => {
    const generic = JSON.stringify({ type: "GENERIC", created_at: "2026-08-20T12:00:00.000Z", content: "hello there" });
    const system = JSON.stringify({ type: "SYSTEM_MESSAGE", created_at: "2026-08-20T12:00:00.000Z", content: "system note" });
    expect(parseAntigravityTranscriptJsonl(generic, { sessionKey: "s" })[0].label).toBe("token:input");
    expect(parseAntigravityTranscriptJsonl(system, { sessionKey: "s" })[0].label).toBe("token:input");
  });
});

describe("parseDeepSeekSessionJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseDeepSeekSessionJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseDeepSeekSessionJsonl("garbage", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseDeepSeekSessionJsonl("true", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line with no usage object", () => {
    expect(parseDeepSeekSessionJsonl(JSON.stringify({ model: "deepseek-chat" }), { sessionKey: "s" })).toEqual([]);
  });

  it("parses prompt_tokens/completion_tokens shape and defaults the model", () => {
    const line = JSON.stringify({
      timestamp: "2026-08-20T16:00:00.000Z",
      usage: { prompt_tokens: 800, completion_tokens: 200, prompt_cache_hit_tokens: 150 },
    });
    const events = parseDeepSeekSessionJsonl(line, { sessionKey: "test/ds-session.jsonl" });
    expect(events[0].producerKeyRef).toBe("deepseek-chat");
    expect(events[0].provider).toBe("deepseek");
  });

  it("falls back to metrics.usage and input_tokens/output_tokens naming", () => {
    const line = JSON.stringify({
      model: "deepseek-v4-pro",
      created_at: "2026-08-20T16:00:00.000Z",
      metrics: {
        usage: {
          input_tokens: 400,
          output_tokens: 100,
          cache_read_input_tokens: 50,
          prompt_cache_miss_tokens: 10,
        },
      },
    });
    const events = parseDeepSeekSessionJsonl(line, { sessionKey: "s" });
    expect(events[0].producerKeyRef).toBe("deepseek-v4-pro");
  });
});

describe("parseCursorSessionJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseCursorSessionJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseCursorSessionJsonl("garbage", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseCursorSessionJsonl("[1]", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line with no usage/tokenCount", () => {
    expect(parseCursorSessionJsonl(JSON.stringify({ model: "cursor-default" }), { sessionKey: "s" })).toEqual([]);
  });

  it("treats a numeric usage as input tokens and defaults the model", () => {
    const line = JSON.stringify({ timestamp: "2026-08-01T00:00:00.000Z", usage: 42 });
    const events = parseCursorSessionJsonl(line, { sessionKey: "s" });
    expect(events[0].producerKeyRef).toBe("cursor-default");
    expect(events[0].label).toBe("token:input");
    expect(events[0].quantity).toBe(42);
  });

  it("reads an object usage/tokenCount shape with cached tokens", () => {
    const line = JSON.stringify({
      model: "cursor-fast",
      timestamp: "2026-08-01T00:00:00.000Z",
      tokenCount: { inputTokens: 100, outputTokens: 10, cachedTokens: 20 },
    });
    const events = parseCursorSessionJsonl(line, { sessionKey: "s" });
    expect(events[0].producerKeyRef).toBe("cursor-fast");
    expect(events.find((e) => e.label === "token:cacheRead")?.quantity).toBe(20);
  });
});

describe("parseCopilotEventsJsonl", () => {
  it("returns nothing for an empty string", () => {
    expect(parseCopilotEventsJsonl("", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that is not JSON", () => {
    expect(parseCopilotEventsJsonl("garbage", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a line that does not start with {", () => {
    expect(parseCopilotEventsJsonl("[]", { sessionKey: "s" })).toEqual([]);
  });

  it("skips a non-shutdown event type", () => {
    const line = JSON.stringify({ type: "assistant.message", data: { outputTokens: 12, model: "gpt-5.4" } });
    expect(parseCopilotEventsJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("skips a shutdown with no modelMetrics", () => {
    const line = JSON.stringify({ type: "session.shutdown", data: {} });
    expect(parseCopilotEventsJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("skips a model row with an empty model name or unusable usage", () => {
    const line = JSON.stringify({
      type: "session.shutdown",
      data: { modelMetrics: { "": { usage: { inputTokens: 1 } }, "some-model": null } },
    });
    expect(parseCopilotEventsJsonl(line, { sessionKey: "s" })).toEqual([]);
  });

  it("emits shutdown deltas, not cumulative totals, across repeated shutdowns", () => {
    const first = {
      type: "session.shutdown",
      id: "shut-1",
      timestamp: "2026-08-01T12:00:00.000Z",
      data: {
        modelMetrics: {
          "deepseek-v4-pro": {
            usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50 },
          },
        },
      },
    };
    const next = {
      type: "session.shutdown",
      id: "shut-3",
      timestamp: "2026-08-01T12:10:00.000Z",
      data: {
        modelMetrics: {
          "deepseek-v4-pro": { inputTokens: 2500, outputTokens: 180, cacheReadTokens: 400, cacheWriteTokens: 50 },
        },
      },
    };
    const events = parseCopilotEventsJsonl([JSON.stringify(first), JSON.stringify(next)].join("\n"), {
      sessionKey: "session-state/abc/events.jsonl",
    });
    expect(events.every((e) => e.producerKeyRef === "deepseek-v4-pro")).toBe(true);
    const totalInput = events.filter((e) => e.label === "token:input").reduce((sum, e) => sum + e.quantity, 0);
    expect(totalInput).toBe(750 + 1300);
  });

  it("treats inputTokens as inclusive of cache writes (Copilot-specific split)", () => {
    const line = JSON.stringify({
      type: "session.shutdown",
      timestamp: "2026-05-07T10:57:19.746Z",
      data: {
        modelMetrics: {
          "claude-opus-4.7": {
            usage: { inputTokens: 23399, outputTokens: 2994, cacheReadTokens: 10069, cacheWriteTokens: 13324 },
          },
        },
      },
    });
    const events = parseCopilotEventsJsonl(line, { sessionKey: "ccusage-1174" });
    expect(events.find((e) => e.label === "token:input")?.quantity).toBe(6);
    expect(events.find((e) => e.label === "token:cacheRead")?.quantity).toBe(10069);
    expect(events.find((e) => e.label === "token:cacheCreation")?.quantity).toBe(13324);
  });

  it("skips a shutdown whose delta against the previous snapshot has no tokens", () => {
    const same = {
      type: "session.shutdown",
      id: "shut-1",
      timestamp: "2026-08-01T12:00:00.000Z",
      data: { modelMetrics: { "m1": { usage: { inputTokens: 100, outputTokens: 10 } } } },
    };
    const events = parseCopilotEventsJsonl([JSON.stringify(same), JSON.stringify(same)].join("\n"), {
      sessionKey: "s",
    });
    // Second shutdown repeats the same snapshot -> delta is all zero -> skipped.
    expect(events.filter((e) => e.metadata?.tokenType === "input")).toHaveLength(1);
  });
});

describe("chunkEvents", () => {
  it("returns an empty array for zero events", () => {
    expect(chunkEvents([])).toEqual([]);
  });

  it("returns a single partial batch for fewer than one batch worth of events", () => {
    const events = new Array(5).fill("e");
    const chunks = chunkEvents(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it("returns exactly one full batch for exactly MAX_EVENTS_PER_BATCH events", () => {
    const events = new Array(MAX_EVENTS_PER_BATCH).fill("e");
    const chunks = chunkEvents(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  it("splits into multiple batches for more than one batch worth of events", () => {
    const events = new Array(250).fill("e");
    const chunks = chunkEvents(events);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });
});

describe("filterEventsSince", () => {
  it("returns everything when since is undefined", () => {
    const events = [{ occurredAt: "2026-01-01T00:00:00.000Z" }];
    expect(filterEventsSince(events, undefined)).toBe(events);
  });

  it("returns everything when since is null", () => {
    const events = [{ occurredAt: "2026-01-01T00:00:00.000Z" }];
    expect(filterEventsSince(events, null)).toBe(events);
  });

  it("drops events with an unparseable occurredAt", () => {
    const events = [{ occurredAt: "not-a-date" }, { occurredAt: "2026-06-01T00:00:00.000Z" }];
    const out = filterEventsSince(events, new Date("2026-01-01T00:00:00.000Z"));
    expect(out).toHaveLength(1);
    expect(out[0].occurredAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("keeps only events at or after the since timestamp", () => {
    const events = [
      { occurredAt: "2026-01-01T00:00:00.000Z" },
      { occurredAt: "2026-06-01T00:00:00.000Z" },
      { occurredAt: "2026-06-01T00:00:00.000Z" },
    ];
    const out = filterEventsSince(events, new Date("2026-03-01T00:00:00.000Z"));
    expect(out).toHaveLength(2);
  });
});

describe("postUsageBatches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const noopLog = () => {};

  it("returns early without calling fetch when dryRun is true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await postUsageBatches({
      events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
      ingestUrl: "https://example.test/ingest",
      ingestToken: undefined,
      producerId: "test-producer",
      dryRun: true,
      log: noopLog,
    });
    expect(result.dryRun).toBe(true);
    expect(result.received).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when ingestToken is missing and dryRun is false", async () => {
    await expect(
      postUsageBatches({
        events: [],
        ingestUrl: "https://example.test/ingest",
        ingestToken: undefined,
        producerId: "test-producer",
        dryRun: false,
        log: noopLog,
      })
    ).rejects.toThrow("Missing ingest token");
  });

  it("posts a single batch and returns the parsed ack on a 200 with valid JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ received: 1, persisted: 1, rejected: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await postUsageBatches({
      events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    expect(result.received).toBe(1);
    expect(result.persisted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles a 200 response whose body is not JSON by falling back to batch length", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => "not json",
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = [{ occurredAt: "2026-01-01T00:00:00.000Z" }, { occurredAt: "2026-01-02T00:00:00.000Z" }];
    const result = await postUsageBatches({
      events,
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    expect(result.received).toBe(2);
    expect(result.persisted).toBe(0);
  });

  it("retries after a 429 then succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        ok: false,
        text: async () => JSON.stringify({ error: { retryAfterSeconds: 0.001 } }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ received: 1, persisted: 1, rejected: 0 }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const promise = postUsageBatches({
      events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.received).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a 503 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 503,
        ok: false,
        text: async () => "not json",
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ received: 1, persisted: 1, rejected: 0 }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const promise = postUsageBatches({
      events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.received).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a network rejection then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ received: 1, persisted: 1, rejected: 0 }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const promise = postUsageBatches({
      events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.received).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a rejection error for a non-ok, non-202, non-retryable status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ error: { code: "bad_request", message: "nope" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      postUsageBatches({
        events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
        ingestUrl: "https://example.test/ingest",
        ingestToken: "fake-token-not-real",
        producerId: "test-producer",
        dryRun: false,
        log: noopLog,
      })
    ).rejects.toThrow(/bad_request/);
  });

  it("accepts a 202 as a successful response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      ok: false,
      text: async () => JSON.stringify({ received: 1, persisted: 0, rejected: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await postUsageBatches({
      events: [{ occurredAt: "2026-01-01T00:00:00.000Z" }],
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    expect(result.received).toBe(1);
  });

  it("posts multiple batches sequentially, sleeping between them", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ received: 1, persisted: 1, rejected: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = new Array(MAX_EVENTS_PER_BATCH + 5).fill(0).map((_, i) => ({
      occurredAt: "2026-01-01T00:00:00.000Z",
      i,
    }));
    const promise = postUsageBatches({
      events,
      ingestUrl: "https://example.test/ingest",
      ingestToken: "fake-token-not-real",
      producerId: "test-producer",
      dryRun: false,
      log: noopLog,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.received).toBe(2);
  });
});

// Producer id / constant sanity — cheap to assert, keeps the exports honest.
describe("producer id constants", () => {
  it("are distinct, non-empty strings", () => {
    const ids = [
      CODEX_PRODUCER_ID,
      GROK_PRODUCER_ID,
      COPILOT_PRODUCER_ID,
      ANTIGRAVITY_PRODUCER_ID,
      CLAUDE_PRODUCER_ID,
      DEEPSEEK_PRODUCER_ID,
      CURSOR_PRODUCER_ID,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("exposes the tick/batch size constants", () => {
    expect(GROK_COST_USD_TICKS).toBe(1e10);
    expect(MAX_EVENTS_PER_BATCH).toBe(100);
  });
});
