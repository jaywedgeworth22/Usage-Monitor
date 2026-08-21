import crypto from "crypto";
import { persistExternalUsageEvents } from "@/lib/external-usage-events";
import { bustBudgetStatusCache } from "@/lib/budget-status";

export const OWNER_EXPENSE_SOURCE_APP = "owner-recorded-expense";

export const OWNER_EXPENSE_KINDS = ["subscription", "prepaid", "one_time"] as const;
export type OwnerExpenseKind = (typeof OWNER_EXPENSE_KINDS)[number];

export interface OwnerExpenseInput {
  provider: string;
  amountUsd: number;
  occurredAt: Date;
  kind: OwnerExpenseKind;
  label: string;
  notes?: string;
  confidence: "actual" | "estimated";
  receiptInboxId?: string;
}

export interface RecordedOwnerExpense {
  persisted: number;
  idempotencyKey: string;
  provider: string;
  amountUsd: number;
  occurredAt: string;
  kind: OwnerExpenseKind;
}

const MAX_AMOUNT_USD = 5_000;
const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;

function isOwnerExpenseKind(value: string): value is OwnerExpenseKind {
  return (OWNER_EXPENSE_KINDS as readonly string[]).includes(value);
}

export function parseOwnerExpenseInput(body: unknown): OwnerExpenseInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const provider =
    typeof record.provider === "string" ? record.provider.trim() : "";
  if (!provider || provider.length > 80) {
    throw new Error("provider must be 1-80 characters");
  }
  const amountUsd = record.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    throw new Error("amountUsd must be a finite number");
  }
  if (amountUsd === 0 || Math.abs(amountUsd) > MAX_AMOUNT_USD) {
    throw new Error(`amountUsd must be non-zero and at most $${MAX_AMOUNT_USD}`);
  }
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (!isOwnerExpenseKind(kind)) {
    throw new Error('kind must be "subscription", "prepaid", or "one_time"');
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || label.length > 160) {
    throw new Error("label must be 1-160 characters");
  }
  const notes =
    typeof record.notes === "string" && record.notes.trim().length > 0
      ? record.notes.trim()
      : undefined;
  if (notes && notes.length > 500) {
    throw new Error("notes must be at most 500 characters");
  }
  const confidence =
    record.confidence === "estimated" || record.confidence === "actual"
      ? record.confidence
      : "actual";
  const occurredAt = new Date(String(record.occurredAt ?? ""));
  if (
    typeof record.occurredAt !== "string" ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== record.occurredAt
  ) {
    throw new Error("occurredAt must be a canonical ISO timestamp");
  }
  const receiptInboxId =
    typeof record.receiptInboxId === "string" && record.receiptInboxId.length > 0
      ? record.receiptInboxId.trim()
      : undefined;
  if (receiptInboxId && !RECEIPT_ID_PATTERN.test(receiptInboxId)) {
    throw new Error("receiptInboxId must be a 64-hex inbox id");
  }
  return {
    provider,
    amountUsd,
    occurredAt,
    kind,
    label,
    notes,
    confidence,
    receiptInboxId,
  };
}

export function ownerExpenseIdempotencyKey(input: OwnerExpenseInput): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        "owner-recorded-expense:v1",
        input.provider.toLowerCase(),
        input.kind,
        input.amountUsd.toFixed(6),
        input.occurredAt.toISOString(),
        input.label,
        input.receiptInboxId ?? "",
      ].join("\0")
    )
    .digest("hex");
  return `owner-recorded-expense:v1:${digest}`;
}

export async function recordOwnerExpense(
  input: OwnerExpenseInput
): Promise<RecordedOwnerExpense> {
  const idempotencyKey = ownerExpenseIdempotencyKey(input);
  const result = await persistExternalUsageEvents([
    {
      idempotencyKey,
      sourceApp: OWNER_EXPENSE_SOURCE_APP,
      provider: input.provider,
      service: input.kind,
      label: input.label,
      billingMode: "manual",
      metricType: input.kind === "subscription" ? "subscription" : "cost",
      unit: "usd",
      costUsd: input.amountUsd,
      confidence: input.confidence,
      occurredAt: input.occurredAt,
      metadata: {
        ownerRecorded: true,
        kind: input.kind,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.receiptInboxId ? { receiptInboxId: input.receiptInboxId } : {}),
      },
    },
  ]);
  bustBudgetStatusCache();
  return {
    persisted: result.persisted,
    idempotencyKey,
    provider: input.provider,
    amountUsd: input.amountUsd,
    occurredAt: input.occurredAt.toISOString(),
    kind: input.kind,
  };
}
