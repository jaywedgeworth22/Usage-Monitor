import { describe, expect, it } from "vitest";
import {
  resolveAgentSeat,
  type AgentSeatSubscriptionInput,
} from "../agent-seat-plans";

function sub(
  partial: Partial<AgentSeatSubscriptionInput> & Pick<AgentSeatSubscriptionInput, "name">
): AgentSeatSubscriptionInput {
  return {
    status: "active",
    costUsd: 20,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    ...partial,
  };
}

describe("resolveAgentSeat", () => {
  it("uses Claude Max 20x $200, not Pro $20, when no subscription matches", () => {
    const seat = resolveAgentSeat("claude-code", []);
    expect(seat.planName).toBe("Claude Max 20x");
    expect(seat.listMonthlyUsd).toBe(200);
    expect(seat.billedMonthlyUsd).toBe(200);
    expect(seat.source).toBe("catalog");
  });

  it("ignores a leftover Claude Pro $20 row so the Max catalog is not understated", () => {
    const seat = resolveAgentSeat("claude-code", [
      sub({ name: "Claude Pro", costUsd: 20, status: "active" }),
    ]);
    expect(seat.listMonthlyUsd).toBe(200);
    expect(seat.billedMonthlyUsd).toBe(200);
    expect(seat.planName).toBe("Claude Max 20x");
    expect(seat.source).toBe("catalog");
  });

  it("adopts an active Claude Max $200 subscription name", () => {
    const seat = resolveAgentSeat("claude-code", [
      sub({ name: "Claude Max 20x", costUsd: 200 }),
    ]);
    expect(seat.source).toBe("subscription");
    expect(seat.planName).toBe("Claude Max 20x");
    expect(seat.listMonthlyUsd).toBe(200);
    expect(seat.billedMonthlyUsd).toBe(200);
  });

  it("uses SuperGrok Heavy $300 list and $100 promo billed by default", () => {
    const seat = resolveAgentSeat("grok-build", []);
    expect(seat.planName).toBe("SuperGrok Heavy");
    expect(seat.listMonthlyUsd).toBe(300);
    expect(seat.billedMonthlyUsd).toBe(100);
    expect(seat.note).toMatch(/\$100/);
    expect(seat.source).toBe("catalog");
  });

  it("ignores a SuperGrok $30 row so Heavy is not shown as the $30 plan", () => {
    const seat = resolveAgentSeat("grok-build", [
      sub({
        name: "SuperGrok",
        costUsd: 30,
        providerName: "xai",
        providerDisplayName: "xAI (Grok)",
      }),
    ]);
    expect(seat.listMonthlyUsd).toBe(300);
    expect(seat.billedMonthlyUsd).toBe(100);
    expect(seat.planName).toBe("SuperGrok Heavy");
    expect(seat.source).toBe("catalog");
  });

  it("keeps Heavy list $300 when an active promo subscription bills $100", () => {
    const seat = resolveAgentSeat("grok-build", [
      sub({
        name: "SuperGrok Heavy",
        costUsd: 100,
        providerName: "xai",
        providerDisplayName: "xAI",
      }),
    ]);
    expect(seat.source).toBe("subscription");
    expect(seat.listMonthlyUsd).toBe(300);
    expect(seat.billedMonthlyUsd).toBe(100);
    expect(seat.planName).toBe("SuperGrok Heavy");
  });

  it("raises billed and list when the live Heavy subscription is the full $300", () => {
    const seat = resolveAgentSeat("grok-build", [
      sub({
        name: "SuperGrok Heavy",
        costUsd: 300,
        providerName: "xai",
        providerDisplayName: "xAI",
      }),
    ]);
    expect(seat.listMonthlyUsd).toBe(300);
    expect(seat.billedMonthlyUsd).toBe(300);
    expect(seat.note).toBeNull();
  });

  it("does not treat xAI API prepaid as the SuperGrok seat", () => {
    const seat = resolveAgentSeat("grok-build", [
      sub({
        name: "API prepaid credits",
        costUsd: 500,
        providerName: "xai",
        providerDisplayName: "xAI API",
      }),
    ]);
    expect(seat.source).toBe("catalog");
    expect(seat.listMonthlyUsd).toBe(300);
  });

  it("uses ChatGPT Pro $200 for Codex rather than Plus $20", () => {
    const cheap = resolveAgentSeat("openai-codex", [
      sub({
        name: "ChatGPT Plus",
        costUsd: 20,
        providerName: "openai",
        providerDisplayName: "OpenAI",
      }),
    ]);
    expect(cheap.listMonthlyUsd).toBe(200);
    expect(cheap.planName).toBe("ChatGPT Pro");

    const pro = resolveAgentSeat("openai-codex", [
      sub({
        name: "ChatGPT Pro",
        costUsd: 200,
        providerName: "openai",
        providerDisplayName: "ChatGPT",
      }),
    ]);
    expect(pro.source).toBe("subscription");
    expect(pro.listMonthlyUsd).toBe(200);
  });

  it("ignores considering and paused rows", () => {
    const seat = resolveAgentSeat("claude-code", [
      sub({ name: "Claude Max 20x", costUsd: 200, status: "considering" }),
      sub({ name: "Claude Max 20x", costUsd: 200, status: "paused" }),
    ]);
    expect(seat.source).toBe("catalog");
  });
});
