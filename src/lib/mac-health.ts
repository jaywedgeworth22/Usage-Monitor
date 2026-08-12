import { prisma } from "@/lib/prisma";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";
import type { NextRequest } from "next/server";

export interface MacProcessStatus {
  name: string;
  status: "running" | "stopped" | "degraded";
  pid?: number | null;
}

export interface MacHostTelemetry {
  hostname: string;
  osVersion?: string;
  arch?: string;
  cpuUsagePct: number;
  memoryUsagePct: number;
  diskUsagePct: number;
  uptimeSeconds: number;
  processes?: Record<string, "running" | "stopped" | "degraded">;
  lastHeartbeatAt: string;
}

export interface MacHealthResponse {
  ok: boolean;
  status: "online" | "degraded" | "offline";
  lastHeartbeatAt: string | null;
  secondsSinceHeartbeat: number | null;
  mac: MacHostTelemetry | null;
}

const ONLINE_THRESHOLD_SECONDS = 180; // 3 minutes

export async function recordMacHeartbeat(data: Partial<MacHostTelemetry>): Promise<MacHostTelemetry> {
  const now = new Date();
  const telemetry: MacHostTelemetry = {
    hostname: data.hostname || "MacBook",
    osVersion: data.osVersion || "macOS",
    arch: data.arch || "arm64",
    cpuUsagePct: Math.min(100, Math.max(0, Number(data.cpuUsagePct) || 0)),
    memoryUsagePct: Math.min(100, Math.max(0, Number(data.memoryUsagePct) || 0)),
    diskUsagePct: Math.min(100, Math.max(0, Number(data.diskUsagePct) || 0)),
    uptimeSeconds: Math.max(0, Math.floor(Number(data.uptimeSeconds) || 0)),
    processes: data.processes || {},
    lastHeartbeatAt: now.toISOString(),
  };

  const idempotencyKey = `mac-heartbeat-${telemetry.hostname}-${now.valueOf()}`;

  await prisma.externalUsageEvent.create({
    data: {
      idempotencyKey,
      sourceApp: "mac-host",
      provider: "local-mac",
      service: "mac-monitoring",
      metricType: "mac_heartbeat",
      billingMode: "estimated",
      confidence: "estimated",
      occurredAt: now,
      metadata: telemetry as unknown as Record<string, unknown>,
    },
  });

  return telemetry;
}

export async function getLatestMacHealth(): Promise<MacHealthResponse> {
  const latestEvent = await prisma.externalUsageEvent.findFirst({
    where: {
      sourceApp: "mac-host",
      metricType: "mac_heartbeat",
    },
    orderBy: { occurredAt: "desc" },
    select: {
      occurredAt: true,
      metadata: true,
    },
  });

  if (!latestEvent || !latestEvent.metadata) {
    return {
      ok: false,
      status: "offline",
      lastHeartbeatAt: null,
      secondsSinceHeartbeat: null,
      mac: null,
    };
  }

  const metadata = latestEvent.metadata as unknown as MacHostTelemetry;
  const lastHeartbeatAt = new Date(metadata.lastHeartbeatAt || latestEvent.occurredAt);
  const secondsSinceHeartbeat = Math.floor((Date.now() - lastHeartbeatAt.getTime()) / 1000);

  let status: "online" | "degraded" | "offline" = "online";
  if (secondsSinceHeartbeat > ONLINE_THRESHOLD_SECONDS) {
    status = "offline";
  } else if (metadata.cpuUsagePct > 90 || metadata.memoryUsagePct > 90 || metadata.diskUsagePct > 95) {
    status = "degraded";
  }

  return {
    ok: status !== "offline",
    status,
    lastHeartbeatAt: lastHeartbeatAt.toISOString(),
    secondsSinceHeartbeat,
    mac: metadata,
  };
}
