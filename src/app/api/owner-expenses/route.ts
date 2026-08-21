import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import {
  parseOwnerExpenseInput,
  recordOwnerExpense,
} from "@/lib/owner-expense";

export async function POST(request: NextRequest) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
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
