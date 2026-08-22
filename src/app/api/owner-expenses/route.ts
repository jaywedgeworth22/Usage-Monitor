import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import { safeEqual, tokenFromRequest } from "@/lib/ingest-auth";
import {
  parseOwnerExpenseInput,
  recordOwnerExpense,
} from "@/lib/owner-expense";

function hasOwnerExpenseToken(request: NextRequest): boolean {
  const expected = process.env.OWNER_EXPENSE_TOKEN?.trim() ?? "";
  if (!expected || expected.length < 32) return false;
  const actual = tokenFromRequest(request, "x-owner-expense-token");
  return Boolean(actual) && safeEqual(actual, expected);
}

export async function POST(request: NextRequest) {
  const sessionOk = hasValidDashboardSession(request);
  if (shouldEnforceDashboardSession() && !sessionOk && !hasOwnerExpenseToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const input = parseOwnerExpenseInput(
      await readBoundedJsonBody(request, { label: "Owner expense body" })
    );
    const recorded = await recordOwnerExpense(input);
    return NextResponse.json(recorded, { status: recorded.persisted > 0 ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    const status = message.includes("must") || message.includes("Body") ? 400 : 500;
    if (status === 500) {
      console.error("Failed to record owner expense:", error);
    }
    return NextResponse.json({ error: message }, { status });
  }
}
