"use client";

import React, { useEffect, useState } from "react";
import type { MacHealthResponse } from "@/lib/mac-health";

export function MacHealthCard() {
  const [data, setData] = useState<MacHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unmounted = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/health/mac");
        if (res.ok) {
          const json = await res.json();
          if (!unmounted) setData(json);
        }
      } catch {
        // keep prior state
      } finally {
        if (!unmounted) setLoading(false);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000);
    return () => {
      unmounted = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm animate-pulse">
        <div className="h-6 w-36 bg-muted rounded mb-4" />
        <div className="h-4 w-48 bg-muted rounded" />
      </div>
    );
  }

  if (!data || !data.mac) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
            <h3 className="font-semibold text-foreground text-sm">Mac Host Monitoring</h3>
          </div>
          <span className="text-xs text-muted-foreground">Offline</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          No Mac heartbeats received yet. Run <code className="text-primary font-mono text-[11px]">scripts/ops/mac-server-watchdog.sh</code> on your Mac.
        </p>
      </div>
    );
  }

  const { mac, status, secondsSinceHeartbeat } = data;
  const isOnline = status === "online";
  const isDegraded = status === "degraded";

  const statusColor = isOnline
    ? "bg-emerald-500"
    : isDegraded
    ? "bg-amber-500"
    : "bg-rose-500";

  const statusText = isOnline
    ? "Online"
    : isDegraded
    ? "High Load"
    : "Offline";

  const formatUptime = (sec: number) => {
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm transition-all">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor} animate-pulse`} />
          <div>
            <h3 className="font-semibold text-foreground text-sm flex items-center gap-2">
              🖥️ {mac.hostname}
            </h3>
            <p className="text-[11px] text-muted-foreground">{mac.osVersion || "macOS"} • {mac.arch || "arm64"}</p>
          </div>
        </div>
        <div className="text-right">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            isOnline ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
            isDegraded ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" :
            "bg-rose-500/10 text-rose-600 dark:text-rose-400"
          }`}>
            {statusText}
          </span>
          <p className="text-[10px] text-muted-foreground mt-1">
            {secondsSinceHeartbeat != null ? `${secondsSinceHeartbeat}s ago` : "recently"}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-muted/40 p-2.5 text-center">
          <div className="text-[11px] font-medium text-muted-foreground">CPU Load</div>
          <div className="text-base font-bold text-foreground mt-0.5">{mac.cpuUsagePct}%</div>
          <div className="w-full bg-muted h-1 rounded-full mt-1.5 overflow-hidden">
            <div
              className={`h-full ${mac.cpuUsagePct > 80 ? "bg-rose-500" : "bg-primary"}`}
              style={{ width: `${Math.min(100, mac.cpuUsagePct)}%` }}
            />
          </div>
        </div>

        <div className="rounded-lg bg-muted/40 p-2.5 text-center">
          <div className="text-[11px] font-medium text-muted-foreground">Memory</div>
          <div className="text-base font-bold text-foreground mt-0.5">{mac.memoryUsagePct}%</div>
          <div className="w-full bg-muted h-1 rounded-full mt-1.5 overflow-hidden">
            <div
              className={`h-full ${mac.memoryUsagePct > 85 ? "bg-amber-500" : "bg-primary"}`}
              style={{ width: `${Math.min(100, mac.memoryUsagePct)}%` }}
            />
          </div>
        </div>

        <div className="rounded-lg bg-muted/40 p-2.5 text-center">
          <div className="text-[11px] font-medium text-muted-foreground">Disk Storage</div>
          <div className="text-base font-bold text-foreground mt-0.5">{mac.diskUsagePct}%</div>
          <div className="w-full bg-muted h-1 rounded-full mt-1.5 overflow-hidden">
            <div
              className={`h-full ${mac.diskUsagePct > 90 ? "bg-rose-500" : "bg-primary"}`}
              style={{ width: `${Math.min(100, mac.diskUsagePct)}%` }}
            />
          </div>
        </div>
      </div>

      {mac.processes && Object.keys(mac.processes).length > 0 && (
        <div className="mt-3.5 pt-3 border-t border-border/60">
          <div className="text-[11px] font-medium text-muted-foreground mb-2">Monitored Host Services</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(mac.processes).map(([name, procStatus]) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] font-mono"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${
                  procStatus === "running" ? "bg-emerald-500" : "bg-rose-500"
                }`} />
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Uptime: {formatUptime(mac.uptimeSeconds)}</span>
        <span>Host: {mac.hostname}</span>
      </div>
    </div>
  );
}
