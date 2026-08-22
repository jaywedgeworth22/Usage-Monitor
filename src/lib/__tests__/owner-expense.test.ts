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

  it("accepts a postdated usage invoice with a due date note", () => {
    const input = parseOwnerExpenseInput({
      provider: "GitHub",
      amountUsd: 200.01,
      occurredAt: "2026-08-21T12:00:00.000Z",
      kind: "usage",
      label: "GitHub Actions usage July 2026",
      notes: "Received 2026-08-21.  Period Jul 1-31 2026.",
      dueDate: "2026-08-28",
      calendarSort: "usage",
    });
    expect(input.kind).toBe("usage");
    expect(input.dueDate).toBe("2026-08-28");
    expect(input.calendarSort).toBe("usage");
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
