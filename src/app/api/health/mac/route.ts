import { NextRequest, NextResponse } from "next/server";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";
import { getLatestMacHealth } from "@/lib/mac-health";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // Allow bearer auth OR dashboard session read
  if (!isUsageReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const health = await getLatestMacHealth();
  return NextResponse.json(health, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
