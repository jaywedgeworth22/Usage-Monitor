import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { computeAgentsOverview } from "../agents-overview";

describe("agents-overview", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes agent overview with model distribution, rollups, and seat costs", async () => {
    vi.spyOn(prisma.externalUsageEvent as any, "groupBy").mockImplementation(async (args: any) => {
      if (args.where?.metricType === "usage") {
        return [
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            label: "input_tokens",
            _sum: { quantity: 100_000 },
          },
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            label: "output_tokens",
            _sum: { quantity: 20_000 },
          },
        ] as any;
      }
      if (args.where?.metricType === "cost") {
        return [
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            _sum: { costUsd: 0.6 },
          },
        ] as any;
      }
      return [] as any;
    });

    vi.spyOn(prisma.externalUsageEventDailyRollup as any, "groupBy").mockImplementation(async (args: any) => {
      if (args.where?.metricType === "usage") {
        return [
          {
            sourceApp: "openai-codex",
            provider: "openai",
            keyRef: "o3-mini",
            label: "input_tokens",
            _sum: { totalQuantity: 50_000 },
          },
        ] as any;
      }
      if (args.where?.metricType === "cost") {
        return [
          {
            sourceApp: "openai-codex",
            provider: "openai",
            keyRef: "o3-mini",
            _sum: { totalCostUsd: 0.15 },
          },
        ] as any;
      }
      return [] as any;
    });

    const result = await computeAgentsOverview(30);
    expect(result.ok).toBe(true);
    expect(result.summary.totalTokens).toBe(170_000);
    expect(result.platforms).toHaveLength(6);
    const claudePlatform = result.platforms.find((p) => p.id === "claude-code");
    expect(claudePlatform).toBeDefined();
    expect(claudePlatform?.totalTokens).toBe(120_000);
    const codexPlatform = result.platforms.find((p) => p.id === "openai-codex");
    expect(codexPlatform).toBeDefined();
    expect(codexPlatform?.totalTokens).toBe(50_000);
  });

  it("reconciles 5h burn cost with max(reported, derived) instead of sum", async () => {
    vi.spyOn(prisma.externalUsageEvent as any, "groupBy").mockImplementation(async (args: any) => {
      if (args.where?.occurredAt?.gte && args.where.occurredAt.gte.getTime() > Date.now() - 6 * 3600 * 1000) {
        if (args.where?.metricType === "usage") {
          return [
            {
              sourceApp: "claude-code",
              provider: "anthropic",
              keyRef: "claude-sonnet",
              label: "input_tokens",
              _sum: { quantity: 100_000 },
            },
          ] as any;
        }
        if (args.where?.metricType === "cost") {
          return [
            {
              sourceApp: "claude-code",
              provider: "anthropic",
              keyRef: "claude-sonnet",
              _sum: { costUsd: 0.5 },
            },
          ] as any;
        }
      }
      return [] as any;
    });

    vi.spyOn(prisma.externalUsageEventDailyRollup as any, "groupBy").mockResolvedValue([] as any);

    const result = await computeAgentsOverview(30);
    expect(result.burn5h.tokens5h).toBe(100_000);
    // Derived for 100k input tokens on claude-3-7-sonnet is $0.30; reported is $0.50. Max is 0.50.
    expect(result.burn5h.costEstimate5hUsd).toBe(0.5);
  });
});
