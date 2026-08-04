import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const hasDashboardSession = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );
  if (hasDashboardSession) return true;
  if (!resolveUsageReadToken()) return false;
  return isUsageReadAuthorized(request);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokens = await prisma.apnsDeviceToken.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      deviceToken: true,
      deviceModel: true,
      osVersion: true,
      environment: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    count: tokens.length,
    tokens: tokens.map((t) => ({
      ...t,
      deviceTokenPreview: t.deviceToken.length > 12
        ? `${t.deviceToken.slice(0, 6)}...${t.deviceToken.slice(-6)}`
        : t.deviceToken,
    })),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { deviceToken, deviceModel, osVersion, environment } = body;

    if (!deviceToken || typeof deviceToken !== "string" || deviceToken.trim().length === 0) {
      return NextResponse.json(
        { error: "deviceToken (non-empty string) is required" },
        { status: 400 }
      );
    }

    const cleanToken = deviceToken.trim().replaceAll(/[\s<>]/g, "");

    const tokenRecord = await prisma.apnsDeviceToken.upsert({
      where: { deviceToken: cleanToken },
      create: {
        deviceToken: cleanToken,
        deviceModel: typeof deviceModel === "string" ? deviceModel.trim() : null,
        osVersion: typeof osVersion === "string" ? osVersion.trim() : null,
        environment: typeof environment === "string" ? environment.trim() : "production",
        isActive: true,
      },
      update: {
        deviceModel: typeof deviceModel === "string" ? deviceModel.trim() : undefined,
        osVersion: typeof osVersion === "string" ? osVersion.trim() : undefined,
        environment: typeof environment === "string" ? environment.trim() : undefined,
        isActive: true,
      },
    });

    return NextResponse.json({
      ok: true,
      id: tokenRecord.id,
      deviceTokenPreview: `${cleanToken.slice(0, 6)}...${cleanToken.slice(-6)}`,
      registeredAt: tokenRecord.updatedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to register APNs token" },
      { status: 500 }
    );
  }
}
