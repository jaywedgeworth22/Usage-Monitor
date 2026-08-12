import { NextRequest, NextResponse } from "next/server";
import { resolveUsageIngestCredential } from "@/lib/ingest-auth";
import { recordMacHeartbeat } from "@/lib/mac-health";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const credential = resolveUsageIngestCredential(request);
  if (!credential) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const telemetry = await recordMacHeartbeat(body);
    return NextResponse.json({ ok: true, telemetry });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
