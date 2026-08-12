#!/usr/bin/env node
//
// Parsing checks for scripts/antigravity-usage-collector.mjs.
//
// The collector shells out to `agy`, which only exists on the Mac that runs
// Antigravity — CI has no such binary and no authenticated session. So these
// checks replay a REAL envelope captured from `agy -p "/usage"
// --output-format json` on 2026-08-12 instead of invoking the CLI, which is
// also what pins the payload shape the parser was written against: if a
// future agy changes it, the live collector breaks and this fixture is the
// record of what it used to emit.

import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";

import {
  assertUniqueSeriesKeys,
  buildEvents,
  extractQuotaRecords,
} from "./antigravity-usage-collector.mjs";

// Verbatim from a real run, with the long human-readable `description`
// strings trimmed (the parser never reads them).
const REAL_ENVELOPE = {
  conversation_id: "",
  status: "SUCCESS",
  response:
    "Gemini Models\tWeekly Limit Remaining\t93%\t2026-08-19T02:08:16Z\n" +
    "Gemini Models\tFive Hour Limit Remaining\t96%\t2026-08-12T12:08:16Z\n" +
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-08-19T07:30:51Z\n" +
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-08-12T12:30:51Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit. […]",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description: "You have used some of your weekly limit […]",
              window: "weekly",
              remaining_fraction: 0.9267072081565857,
              reset_time: "2026-08-19T02:08:16Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              description: "You have used some of your 5-hour limit […]",
              window: "5h",
              remaining_fraction: 0.9563161134719849,
              reset_time: "2026-08-12T12:08:16Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-08-19T07:30:51Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-08-12T12:30:51Z",
            },
          ],
        },
      ],
    },
  },
};

const OCCURRED_AT = "2026-08-12T07:31:15.720Z";
const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

check("structured command payload is the preferred source", () => {
  const records = extractQuotaRecords(REAL_ENVELOPE);
  assertEqual(records.length, 4, "one record per (group, window) bucket");
  assertEqual(records[0].seriesKey, "gemini-weekly", "series key is the stable bucket id");
  assertEqual(records[0].label, "Gemini Models (weekly)", "label names group and window");
  // 92.67, not the 93% the rendered `response` line rounds to — proof the
  // structured path won over the text fallback.
  assertEqual(records[0].percentRemaining, 92.67, "full-precision fraction, converted to percent");
  assertEqual(records[0].resetAt, "2026-08-19T02:08:16Z", "reset time carried through");
  assertEqual(records[1].window, "5h", "the second bucket is the 5h window");
});

check("quota is metered per group and window, never per group alone", () => {
  const records = extractQuotaRecords(REAL_ENVELOPE);
  const groups = new Set(records.map((r) => r.group));
  assertEqual(groups.size, 2, "two model groups");
  assertEqual(new Set(records.map((r) => r.seriesKey)).size, 4, "four distinct series");
});

check("events are well formed and collision free", () => {
  const events = buildEvents(REAL_ENVELOPE, OCCURRED_AT);
  assertEqual(events.length, 4, "four events");
  assertEqual(new Set(events.map((e) => e.eventId)).size, 4, "four distinct eventIds");

  const [geminiWeekly] = events;
  assertEqual(geminiWeekly.provider, "google-antigravity", "provider");
  assertEqual(geminiWeekly.service, "antigravity-cli", "service");
  assertEqual(geminiWeekly.metricType, "quota", "metricType");
  assertEqual(geminiWeekly.billingMode, "actual", "billingMode");
  assertEqual(geminiWeekly.confidence, "actual", "confidence");
  assertEqual(geminiWeekly.limit, 100, "percent scale limit");
  assertEqual(geminiWeekly.credits, 92.67, "credits are percent remaining");
  assertEqual(geminiWeekly.occurredAt, OCCURRED_AT, "occurredAt is passed through");
  assertEqual(geminiWeekly.metadata.scale, "percent_0_100", "scale is declared in metadata");
  assertEqual(geminiWeekly.metadata.rawPercentUsed, 7.33, "percent used complements remaining");
  assertEqual(geminiWeekly.metadata.bucketId, "gemini-weekly", "bucket id in metadata");
  assertEqual(geminiWeekly.metadata.quotaWindow, "weekly", "window in metadata");

  // credits/limit share one scale, so this is always meaningful.
  for (const event of events) {
    assert(
      event.credits >= 0 && event.credits <= event.limit,
      `${event.label}: credits ${event.credits} out of range for limit ${event.limit}`
    );
  }
});

check("eventIds are stable for a given reading and move with the clock", () => {
  const first = buildEvents(REAL_ENVELOPE, OCCURRED_AT);
  const same = buildEvents(REAL_ENVELOPE, OCCURRED_AT);
  const later = buildEvents(REAL_ENVELOPE, "2026-08-12T11:31:15.720Z");
  assertEqual(first[0].eventId, same[0].eventId, "same reading, same eventId");
  assert(first[0].eventId !== later[0].eventId, "a later tick must be a new event");
});

check("headerless response text is the fallback when command is absent", () => {
  const { command, ...withoutCommand } = REAL_ENVELOPE;
  void command;
  const records = extractQuotaRecords(withoutCommand);
  assertEqual(records.length, 4, "all four rendered lines parse");
  assertEqual(records[0].group, "Gemini Models", "first column is the group");
  assertEqual(records[0].window, "Weekly Limit Remaining", "second column is the bucket name");
  assertEqual(records[0].percentRemaining, 93, "the rendered percent, rounded by the CLI");
  assertEqual(records[0].resetAt, "2026-08-19T02:08:16Z", "trailing column is the reset time");
  assertUniqueSeriesKeys(records);
  assertEqual(new Set(records.map((r) => r.seriesKey)).size, 4, "still four distinct series");
});

check("a self-describing header row takes priority over positional reads", () => {
  const records = extractQuotaRecords({
    status: "SUCCESS",
    response:
      "Model\tRemaining\tReset\n" +
      "gemini-pro\t42%\t2026-08-19T02:08:16Z\n",
  });
  assertEqual(records.length, 1, "one record");
  assertEqual(records[0].label, "gemini-pro", "model column is used when there is no group");
  assertEqual(records[0].percentRemaining, 42, "percent parsed from the named column");
});

check("absolute counts still win over the percent fallback", () => {
  const envelope = {
    models: [{ model: "gemini-pro", remaining: 250, limit: 1000, window: "weekly" }],
  };
  assertEqual(extractQuotaRecords(envelope).length, 1, "one record from the object path");

  const [event] = buildEvents(envelope, OCCURRED_AT);
  assertEqual(event.limit, 1000, "absolute limit is preserved");
  assertEqual(event.credits, 250, "absolute remaining is preserved");
  assertEqual(event.metadata.scale, undefined, "no percent-scale marker on absolute events");
});

// The collector posts straight to prod, so the batch it builds has to satisfy
// the same schema the ingest route validates with — catching a shape error
// here beats discovering it as a 400 from a launchd job nobody is watching.
check("the built batch validates against the shared v2 ingest schema", () => {
  const result = UsageTelemetryV2BatchSchema.safeParse({
    schemaVersion: 2,
    producerId: "antigravity-cli",
    producerInstanceId: "test-host.local",
    events: buildEvents(REAL_ENVELOPE, OCCURRED_AT),
  });
  assert(
    result.success,
    `batch rejected by UsageTelemetryV2BatchSchema: ${JSON.stringify(result.error?.issues)}`
  );
});

check("colliding series keys fail loudly instead of losing a reading", () => {
  let threw = false;
  try {
    assertUniqueSeriesKeys([
      { seriesKey: "Gemini Models", label: "Gemini Models (weekly)" },
      { seriesKey: "Gemini Models", label: "Gemini Models (5h)" },
    ]);
  } catch (error) {
    threw = true;
    assert(
      /share the series key/.test(String(error.message)),
      `unexpected error message: ${error.message}`
    );
  }
  assert(threw, "duplicate series keys must throw");
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} antigravity collector check(s) failed`);
  process.exit(1);
}

console.log("antigravity collector parsing checks passed");
