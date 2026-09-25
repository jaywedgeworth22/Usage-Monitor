import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Prisma } from "@prisma/client";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// Exercises loadAgentModelMixRows against a REAL throwaway SQLite database
// (never the dev `data`/`dev.db`), not a mocked Prisma client -- same reason
// cost-by-session.db.test.ts exists (see that file's docblock): a mocked
// Prisma unit test cannot catch a bug in how the raw SQLite driver infers a
// COMPUTED column's runtime type.
//
// This specific regression: production threw `RangeError: The number
// 0.3498095 cannot be converted to a BigInt because it is not an integer`
// from every call. Root cause -- confirmed by reproducing it here before the
// fix and watching it disappear after -- SQLite's $queryRaw type inference
// samples the FIRST returned row's storage class per column. The original
// query's SUM(CASE ...) aggregates were not CAST to REAL, so when the first
// GROUP BY bucket's sum happened to land on an exact integer (a group with
// no matching 'cost' events sums to literal 0), Prisma inferred
// Int64/BigInt for that whole column and crashed converting a LATER group's
// genuinely fractional dollar amount. See agent-model-mix.ts's module
// docblock for the full incident note. The fix wraps both SUMs in
// CAST(... AS REAL).
//
// The two groups below are seeded in the same order that triggered it in
// production: an all-"usage" group (exact-zero cost) with a keyRef that
// sorts/groups before a "cost"-bearing group with a real fractional amount.
let dbPath: string;
let loadAgentModelMixRows: typeof import("../agent-model-mix").loadAgentModelMixRows;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-mix-db-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ loadAgentModelMixRows } = await import("../agent-model-mix"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

beforeEach(async () => {
  await prisma.externalUsageEvent.deleteMany({});
});

async function seedEvent(overrides: {
  idempotencyKey: string;
  sourceApp?: string;
  provider?: string;
  keyRef?: string | null;
  metricType: string;
  unit?: string | null;
  quantity?: number | null;
  costUsd?: number | null;
  metadata?: Prisma.InputJsonValue;
  occurredAt: Date;
}) {
  await prisma.externalUsageEvent.create({
    data: {
      idempotencyKey: overrides.idempotencyKey,
      sourceApp: overrides.sourceApp ?? "claude-code",
      provider: overrides.provider ?? "anthropic",
      keyRef: overrides.keyRef ?? "claude-sonnet-5",
      metricType: overrides.metricType,
      unit: overrides.unit ?? null,
      quantity: overrides.quantity ?? null,
      costUsd: overrides.costUsd ?? null,
      occurredAt: overrides.occurredAt,
      metadata: overrides.metadata ?? {},
    },
  });
}

const WINDOW_START = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-30T00:00:00.000Z");
const OCCURRED_AT = new Date("2026-09-20T10:00:00.000Z");

describe("loadAgentModelMixRows (real SQLite)", () => {
  it("does not throw and returns the correct fractional costUsd when an earlier group's sum is an exact integer", async () => {
    // Group A ("model-a"): only 'usage' events -> the cost CASE's ELSE
    // branch fires every time -> exact integer 0 for that group's costUsd.
    await seedEvent({
      idempotencyKey: "amm-db-a1",
      keyRef: "model-a",
      metricType: "usage",
      unit: "token",
      quantity: 100,
      occurredAt: OCCURRED_AT,
    });
    await seedEvent({
      idempotencyKey: "amm-db-a2",
      keyRef: "model-a",
      metricType: "usage",
      unit: "token",
      quantity: 50,
      occurredAt: OCCURRED_AT,
    });
    // Group B ("model-b"): a real fractional cost -- this is the value that
    // crashed in production once Prisma had locked the column to BigInt
    // from group A's exact-zero sum.
    await seedEvent({
      idempotencyKey: "amm-db-b1",
      keyRef: "model-b",
      metricType: "cost",
      costUsd: 0.3498095,
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(2);
    const groupA = rows.find((r) => r.model === "model-a");
    const groupB = rows.find((r) => r.model === "model-b");
    expect(groupA).toMatchObject({ tokens: 150, costUsd: 0, eventCount: 2 });
    expect(groupB).toMatchObject({ tokens: 0, costUsd: 0.3498095, eventCount: 1 });
    for (const row of rows) {
      expect(typeof row.tokens).toBe("number");
      expect(typeof row.costUsd).toBe("number");
      expect(typeof row.eventCount).toBe("number");
      expect(Number.isNaN(row.tokens)).toBe(false);
      expect(Number.isNaN(row.costUsd)).toBe(false);
    }
  });

  it("groups by sourceApp x provider x model x seat x project and sums tokens/cost/events per group", async () => {
    await seedEvent({
      idempotencyKey: "amm-db-g1",
      sourceApp: "claude-code",
      provider: "anthropic",
      keyRef: "claude-sonnet-5",
      metricType: "usage",
      unit: "token",
      quantity: 1000,
      metadata: { project: "usage-monitor" },
      occurredAt: OCCURRED_AT,
    });
    await seedEvent({
      idempotencyKey: "amm-db-g2",
      sourceApp: "claude-code",
      provider: "anthropic",
      keyRef: "claude-sonnet-5",
      metricType: "usage",
      unit: "token",
      quantity: 500,
      metadata: { project: "usage-monitor" },
      occurredAt: OCCURRED_AT,
    });
    await seedEvent({
      idempotencyKey: "amm-db-g3",
      sourceApp: "codex-cli",
      provider: "openai",
      keyRef: "gpt-5-codex",
      metricType: "cost",
      costUsd: 2.5,
      metadata: { project: "fleet-infra" },
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(2);
    const claudeRow = rows.find((r) => r.sourceApp === "claude-code");
    expect(claudeRow).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      project: "usage-monitor",
      tokens: 1500,
      costUsd: 0,
      eventCount: 2,
    });
    const codexRow = rows.find((r) => r.sourceApp === "codex-cli");
    expect(codexRow).toMatchObject({
      provider: "openai",
      model: "gpt-5-codex",
      project: "fleet-infra",
      tokens: 0,
      costUsd: 2.5,
      eventCount: 1,
    });
  });

  it("excludes events outside the given window", async () => {
    await seedEvent({
      idempotencyKey: "amm-db-out",
      metricType: "usage",
      unit: "token",
      quantity: 999,
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await seedEvent({
      idempotencyKey: "amm-db-in",
      metricType: "usage",
      unit: "token",
      quantity: 10,
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toBe(10);
  });

  it("returns [] for a window with no matching events", async () => {
    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);
    expect(rows).toEqual([]);
  });
});
