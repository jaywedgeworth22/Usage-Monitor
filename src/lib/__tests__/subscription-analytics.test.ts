import { describe, expect, it } from "vitest";
import {
  isClaudeCodeAnalyticsTelemetry,
  isSubscriptionAnalyticsTelemetry,
  shouldDeriveAnalyticsTokenEstimate,
} from "../subscription-analytics";

describe("subscription analytics discriminators", () => {
  it("keeps Claude Code OTLP exact so Anthropic API usage stays cash", () => {
    expect(
      isClaudeCodeAnalyticsTelemetry({ sourceApp: "claude-code", service: "claude-code" })
    ).toBe(true);
    expect(
      isClaudeCodeAnalyticsTelemetry({ sourceApp: "anthropic", service: "messages" })
    ).toBe(false);
    expect(
      isClaudeCodeAnalyticsTelemetry({ sourceApp: "claude-code", service: "api" })
    ).toBe(false);
  });

  it("does not treat claude-code sourceApp alone as analytics", () => {
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "claude-code", service: null })
    ).toBe(false);
  });

  it("treats Codex and Grok Build session ingest as analytics, not cash", () => {
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "openai-codex", service: "codex-cli" })
    ).toBe(true);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "grok-build", service: "grok-cli" })
    ).toBe(true);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "openai", service: "responses" })
    ).toBe(false);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "xai", service: "chat" })
    ).toBe(false);
  });

  it("does not double-count Claude OTLP costUsd with token derivation", () => {
    expect(
      shouldDeriveAnalyticsTokenEstimate({
        sourceApp: "claude-code",
        service: "claude-code",
      })
    ).toBe(false);
    expect(
      shouldDeriveAnalyticsTokenEstimate({
        sourceApp: "openai-codex",
        service: "codex-cli",
      })
    ).toBe(true);
  });
});
