import { describe, expect, it } from "vitest";

import { projectQuotaWindows, quotaStatus } from "../quota-windows";

describe("quotaStatus", () => {
  it("treats remaining 0 and isExhausted as a hit", () => {
    expect(quotaStatus({ remainingPercent: 0, remainingUnknown: false, isExhausted: false })).toBe(
      "exhausted",
    );
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: true, isExhausted: true })).toBe(
      "exhausted",
    );
  });

  it("does not invent Gemini remaining", () => {
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: true, isExhausted: false })).toBe(
      "unknown",
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
    expect(result.skipModelTypes).toEqual([
      { instanceId: "antigravity", model: "claude-opus-4-6-thinking" },
    ]);
    const gemini = result.windows.find((row) => row.modelId === "gemini-3.1-pro-high");
    expect(gemini?.status).toBe("unknown");
    expect(gemini?.skip).toBe(false);
    expect(gemini?.remainingUnknown).toBe(true);
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
