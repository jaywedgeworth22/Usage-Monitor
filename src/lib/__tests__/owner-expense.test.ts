import { describe, expect, it } from "vitest";
import {
  ownerExpenseIdempotencyKey,
  parseOwnerExpenseInput,
} from "../owner-expense";

describe("parseOwnerExpenseInput", () => {
  it("accepts an owner-recorded subscription charge", () => {
    const input = parseOwnerExpenseInput({
      provider: "namecheap",
      amountUsd: 1.18,
      occurredAt: "2026-08-13T00:00:00.000Z",
      kind: "one_time",
      label: "Namecheap order",
      notes: "Gmail receipt",
    });
    expect(input.confidence).toBe("actual");
    expect(input.kind).toBe("one_time");
    expect(ownerExpenseIdempotencyKey(input)).toMatch(
      /^owner-recorded-expense:v1:[0-9a-f]{64}$/
    );
  });

  it("rejects a zero amount", () => {
    expect(() =>
      parseOwnerExpenseInput({
        provider: "fmp",
        amountUsd: 0,
        occurredAt: "2026-08-13T00:00:00.000Z",
        kind: "subscription",
        label: "FMP",
      })
    ).toThrow(/non-zero/);
  });

  it("rejects a malformed inbox id", () => {
    expect(() =>
      parseOwnerExpenseInput({
        provider: "fmp",
        amountUsd: 31.9,
        occurredAt: "2026-06-22T18:01:08.000Z",
        kind: "subscription",
        label: "FMP Starter",
        receiptInboxId: "not-hex",
      })
    ).toThrow(/64-hex/);
  });
});
