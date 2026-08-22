import { describe, expect, it } from "vitest";
import {
  boundedSubject,
  calendarTitle,
  classifyReceipt,
  extractAmountUsd,
} from "./src/classify.mjs";

describe("boundedSubject", () => {
  it("strips emails and cards and truncates", () => {
    expect(boundedSubject("Receipt for billing@x.com visa 4111 1111 1111 1111")).toContain("[email]");
    expect(boundedSubject("Receipt for billing@x.com visa 4111 1111 1111 1111")).toContain("[card]");
    expect(boundedSubject("a".repeat(200)).length).toBe(180);
  });
});

describe("extractAmountUsd", () => {
  it("prefers an amount paid total over a tax line", () => {
    expect(extractAmountUsd("Tax $2.90 Total $31.90 Amount paid $31.90")).toBe(31.9);
  });
});

describe("calendarTitle", () => {
  it("uses price - service - sort", () => {
    expect(calendarTitle({ amountUsd: 200.01, service: "GitHub", sort: "usage" }))
      .toBe("$200.01 - GitHub - usage");
    expect(calendarTitle({ amountUsd: 14.98, service: "Namecheap", sort: "dev-expense" }))
      .toBe("$14.98 - Namecheap - dev-expense");
  });
});

describe("classifyReceipt", () => {
  it("ignores a failed payment", () => {
    const result = classifyReceipt({
      subject: "$5.33 payment to Cursor was unsuccessful",
      receivedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("failed_payment");
  });

  it("files FMP historically and never schedules a next due date", () => {
    const result = classifyReceipt({
      subject: "Your receipt from Financial Modeling Prep #2240-0152",
      text: "Starter Access - Monthly Amount paid $31.90 Paid June 22, 2026",
      senderDomain: "stripe.com",
      receivedAt: "2026-06-22T18:00:00.000Z",
    });
    expect(result.action).toBe("file");
    expect(result.service).toBe("FMP");
    expect(result.cancelledNoRenew).toBe(true);
    expect(result.nextDueDate).toBeNull();
    expect(result.amountUsd).toBe(31.9);
  });

  it("treats domain renewals as a dev expense", () => {
    const result = classifyReceipt({
      subject: "Namecheap Order Summary (Order# 201400665);",
      text: "txadvocacy.com 1 year Final Cost : $14.98",
      senderDomain: "namecheap.com",
      receivedAt: "2026-05-03T12:00:00.000Z",
    });
    expect(result.calendarSort).toBe("dev-expense");
    expect(result.service).toBe("Namecheap");
    expect(result.amountUsd).toBe(14.98);
  });

  it("files postdated usage on the received date and keeps the due date", () => {
    const result = classifyReceipt({
      subject: "[GitHub] Payment Receipt for jaywedgeworth22",
      text: "GitHub Actions Usage: $184.05 USD Jul 1, 2026 - Jul 31, 2026 Total: $200.01 USD",
      senderDomain: "github.com",
      receivedAt: "2026-08-21T20:09:52.000Z",
      dueDate: "2026-08-28T00:00:00.000Z",
    });
    expect(result.kind).toBe("usage");
    expect(result.expenseDate).toBe("2026-08-21");
    expect(result.dueDate).toBe("2026-08-28");
    expect(result.notes).toMatch(/date received/i);
  });
});
