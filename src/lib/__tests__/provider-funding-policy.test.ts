import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let clearLlmMustKeepFundedFlags: typeof import("@/lib/provider-funding-policy").clearLlmMustKeepFundedFlags;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-funding-policy-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ clearLlmMustKeepFundedFlags } = await import("@/lib/provider-funding-policy"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  await prisma.provider.deleteMany();
});

async function createProviderWithPlan(options: {
  name: string;
  mustKeepFunded: boolean;
  alertConfigGeneration?: number;
}) {
  return prisma.provider.create({
    data: {
      name: options.name,
      displayName: options.name,
      type: "builtin",
      alertConfigGeneration: options.alertConfigGeneration ?? 0,
      plan: {
        create: { mustKeepFunded: options.mustKeepFunded, lowBalanceUsd: 5 },
      },
    },
  });
}

describe("clearLlmMustKeepFundedFlags", () => {
  it("clears LLM rows, bumps their alert revision, and leaves non-LLM rows alone", async () => {
    const anthropic = await createProviderWithPlan({
      name: "anthropic",
      mustKeepFunded: true,
      alertConfigGeneration: 3,
    });
    const openai = await createProviderWithPlan({
      name: "openai",
      mustKeepFunded: true,
    });
    const twilio = await createProviderWithPlan({
      name: "twilio",
      mustKeepFunded: true,
      alertConfigGeneration: 2,
    });
    const deepseek = await createProviderWithPlan({
      name: "deepseek",
      mustKeepFunded: false,
      alertConfigGeneration: 1,
    });

    expect(await clearLlmMustKeepFundedFlags()).toBe(2);

    const byId = async (id: string) =>
      prisma.provider.findUniqueOrThrow({ where: { id }, include: { plan: true } });
    expect(await byId(anthropic.id)).toMatchObject({
      alertConfigGeneration: 4,
      plan: { mustKeepFunded: false, lowBalanceUsd: 5 },
    });
    expect(await byId(openai.id)).toMatchObject({
      alertConfigGeneration: 1,
      plan: { mustKeepFunded: false },
    });
    // Non-LLM categories keep their operator-set flag and alert revision.
    expect(await byId(twilio.id)).toMatchObject({
      alertConfigGeneration: 2,
      plan: { mustKeepFunded: true },
    });
    // Already-clear LLM rows are untouched (no phantom revision bump).
    expect(await byId(deepseek.id)).toMatchObject({
      alertConfigGeneration: 1,
      plan: { mustKeepFunded: false },
    });
  });

  it("matches by canonical provider name, not raw casing or alias spelling", async () => {
    const aliased = await createProviderWithPlan({
      name: "Claude",
      mustKeepFunded: true,
    });

    expect(await clearLlmMustKeepFundedFlags()).toBe(1);
    expect(
      await prisma.provider.findUniqueOrThrow({
        where: { id: aliased.id },
        include: { plan: true },
      })
    ).toMatchObject({
      alertConfigGeneration: 1,
      plan: { mustKeepFunded: false },
    });
  });

  it("is idempotent", async () => {
    await createProviderWithPlan({ name: "openrouter", mustKeepFunded: true });

    expect(await clearLlmMustKeepFundedFlags()).toBe(1);
    expect(await clearLlmMustKeepFundedFlags()).toBe(0);
  });
});
