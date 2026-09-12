import { describe, expect, it } from "vitest";

import {
  projectQuotaWindows,
  quotaProviderKey,
  quotaProviderLabel,
  quotaProviderVia,
  quotaStatus,
} from "../quota-windows";

describe("quotaStatus", () => {
  it("treats remaining 0 and isExhausted as a hit", () => {
    expect(quotaStatus({ remainingPercent: 0, remainingUnknown: false, isExhausted: false })).toBe(
      "exhausted",
    );
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: true, isExhausted: true })).toBe(
      "exhausted",
    );
  });

  it("treats omitted remaining (N/A) as exhausted", () => {
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: true, isExhausted: false })).toBe(
      "exhausted",
    );
  });

  it("keeps 30% remaining available", () => {
    expect(quotaStatus({ remainingPercent: 29.75, remainingUnknown: false, isExhausted: false })).toBe(
      "available",
    );
  });
});

describe("projectQuotaWindows", () => {
  it("projects per-model skip targets from antigravity-usage events", () => {
    const result = projectQuotaWindows([
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-04T04:20:02.182Z",
        metadata: {
          modelId: "claude-opus-4-6-thinking",
          isExhausted: true,
          source: "antigravity-usage",
          resetAt: "2026-09-09T07:04:37Z",
        },
      },
      {
        provider: "google-antigravity",
        label: "Gemini 3.1 Pro (High)",
        credits: null,
        limit: 100,
        occurredAt: "2026-09-04T04:20:02.182Z",
        metadata: {
          modelId: "gemini-3.1-pro-high",
          remainingUnknown: true,
          isExhausted: false,
          source: "antigravity-usage",
        },
      },
    ]);
    expect(result.skipModelTypes.map((row) => row.model).sort()).toEqual([
      "claude-opus-4-6-thinking",
      "gemini-3.1-pro-high",
    ]);
    const gemini = result.windows.find((row) => row.modelId === "gemini-3.1-pro-high");
    expect(gemini?.status).toBe("exhausted");
    expect(gemini?.skip).toBe(true);
    expect(gemini?.remainingPercent).toBe(0);
  });

  it("keeps the latest event per series", () => {
    const result = projectQuotaWindows([
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 10,
        limit: 100,
        occurredAt: "2026-09-04T05:00:00.000Z",
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: false },
      },
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-04T04:00:00.000Z",
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: true },
      },
    ]);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.remainingPercent).toBe(10);
    expect(result.skipModelTypes).toEqual([]);
  });
});

describe("provider grouping", () => {
  const events = [
    {
      provider: "google-antigravity",
      label: "Claude and GPT models",
      credits: 42,
      limit: 100,
      occurredAt: "2026-09-12T12:00:00.000Z",
      metadata: { bucketId: "claude-gpt", quotaWindow: "5h", source: "antigravity-usage" },
    },
    {
      provider: "anthropic",
      service: "claude-code",
      label: "5h window",
      credits: 62.5,
      limit: 100,
      occurredAt: "2026-09-12T12:00:00.000Z",
      metadata: {
        bucketId: "anthropic:five_hour",
        quotaWindow: "5h",
        resetAt: "2026-09-12T18:00:00.000Z",
        planType: "max_20x",
        source: "api.anthropic.com",
      },
    },
    {
      provider: "xai",
      service: "grok-cli",
      label: "weekly window",
      credits: 75,
      limit: 100,
      occurredAt: "2026-09-12T12:00:00.000Z",
      metadata: { bucketId: "xai:weekly", quotaWindow: "weekly", source: "cli-chat-proxy.grok.com" },
    },
  ];

  it("labels each provider and marks Antigravity buckets as via antigravity", () => {
    const result = projectQuotaWindows(events);
    const anthropic = result.windows.find((row) => row.provider === "anthropic");
    expect(anthropic?.providerLabel).toBe("Claude");
    expect(anthropic?.via).toBeNull();

    const antigravity = result.windows.find((row) => row.provider === "google-antigravity");
    // Antigravity's own routing bucket is named after Claude and GPT.  It is
    // NOT the user's Claude plan, so it must be marked.
    expect(antigravity?.providerLabel).toBe("Antigravity");
    expect(antigravity?.via).toBe("antigravity");
  });

  it("returns a group for every expected provider, empty ones included", () => {
    const result = projectQuotaWindows(events);
    expect(result.providerGroups.map((group) => group.provider)).toEqual([
      "anthropic",
      "openai",
      "google-antigravity",
      "xai",
      "minimax",
    ]);
    const byProvider = new Map(result.providerGroups.map((group) => [group.provider, group]));
    expect(byProvider.get("anthropic")?.windows).toHaveLength(1);
    expect(byProvider.get("xai")?.windows).toHaveLength(1);
    // Never reported yet: visible as an empty group, not silently absent.
    expect(byProvider.get("openai")?.windows).toEqual([]);
    expect(byProvider.get("minimax")?.windows).toEqual([]);
    expect(byProvider.get("minimax")?.providerLabel).toBe("MiniMax");
    expect(byProvider.get("minimax")?.expected).toBe(true);
  });

  it("collapses provider aliases onto one canonical group", () => {
    expect(quotaProviderKey("google")).toBe("google-antigravity");
    expect(quotaProviderKey("openai-codex")).toBe("openai");
    expect(quotaProviderLabel("grok-build")).toBe("Grok");
    expect(quotaProviderVia("google")).toBe("antigravity");
    expect(quotaProviderVia("anthropic")).toBeNull();
    // An unregistered provider still groups, it just has no friendly label.
    const result = projectQuotaWindows([
      {
        provider: "acme",
        label: "monthly window",
        credits: 50,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "acme:monthly" },
      },
    ]);
    const extra = result.providerGroups.find((group) => group.provider === "acme");
    expect(extra?.expected).toBe(false);
    expect(extra?.windows).toHaveLength(1);
  });

  it("never emits an antigravity skip target for another provider's exhausted window", () => {
    const result = projectQuotaWindows([
      {
        provider: "anthropic",
        label: "7d window (Opus)",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "anthropic:seven_day_opus", modelId: "opus", isExhausted: true },
      },
    ]);
    expect(result.windows[0]?.status).toBe("exhausted");
    // skipModelTypes drives Antigravity instance routing only.
    expect(result.skipModelTypes).toEqual([]);
  });
});
