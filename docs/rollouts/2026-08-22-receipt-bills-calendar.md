# Receipt inbox review fields, owner expenses, Bills calendar

## Why

Forwarded vendor mail was sitting in the receipt Worker as `needs_review` with
only a sender domain.  The owner could not see what arrived, and April 2026+
receipts were not on the ledger or on a calendar.

## What landed

- Inbox summary includes a bounded subject, amount, service, and kind.  Raw
  MIME, cards, and mailbox local-parts stay off the dashboard.
- `POST /api/owner-expenses` accepts `usage` plus optional `dueDate`,
  `nextDueDate`, `cancelledNoRenew`, and `calendarSort`.  Worker intake can POST
  here with `OWNER_EXPENSE_TOKEN` after Grok (DeepSeek backup) classifies.
- Unlisted Apple Calendar feed: `GET /api/bills.ics?token=` with
  `BILLS_CALENDAR_TOKEN`.  Event titles are `$price - Service - sort`.
- Domain renewals file as `dev-expense`.  FMP/Massive file a historical paid
  receipt and never a next due date.  Postdated usage invoices file on the date
  received.

## Verify

```bash
npm test -- src/lib/__tests__/owner-expense.test.ts src/lib/__tests__/bills-calendar.test.ts src/lib/__tests__/operations-health.test.ts src/__tests__/middleware.test.ts workers/receipt-inbox/index.test.mjs workers/receipt-inbox/classify.test.mjs
```

## Follow-ups

- Set `BILLS_CALENDAR_TOKEN` and `OWNER_EXPENSE_TOKEN` in Infisical prod.
- Worker secrets: `XAI_API_KEY` (or `OPENROUTER_RECEIPT_KEY`),
  `OWNER_EXPENSE_TOKEN`, `OWNER_EXPENSE_INGEST_URL=https://usage.jays.services`.
- File the local April JSON with `scripts/file-owner-receipt-expenses.mjs` after
  deploy.  Amounts stay out of git.
