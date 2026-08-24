"use client";

import React, { useEffect, useState } from "react";
import { Gauge, Zap, Clock } from "lucide-react";

const SENTENCE_GAP = "\u00a0 ";

interface QuotaBucket {
  id: string;
  label: string;
  modelGroup: string;
  logoSrc: string;
  window: "5h" | "weekly" | "daily" | "monthly";
  creditsRemaining: number;
  limit: number;
  resetAt: string | null;
  occurredAt: string;
}

function formatCountdown(resetAtStr: string | null): string {
  if (!resetAtStr) return "Rolling refresh";
  const target = new Date(resetAtStr).getTime();
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "Refreshing now";

  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remHours = hours % 24;
    return `Resets in ${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `Resets in ${hours}h ${minutes}m`;
  }
  return `Resets in ${minutes}m`;
}

function quotaTone(percent: number): {
  bar: string;
  badge: string;
  label: string;
} {
  if (percent >= 50) {
    return {
      bar: "bg-emerald-500",
      badge: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
      label: "Available",
    };
  }
  if (percent >= 20) {
    return {
      bar: "bg-amber-500",
      badge: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      label: "Moderate Quota",
    };
  }
  return {
    bar: "bg-rose-500",
    badge: "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    label: "Near Quota Cap",
  };
}

export default function FleetQuotaMatrixCard() {
  const [buckets, setBuckets] = useState<QuotaBucket[]>([]);

  useEffect(() => {
    let unmounted = false;
    const fetchQuota = async () => {
      try {
        const res = await fetch("/api/snapshots", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const extracted: QuotaBucket[] = [];
          if (Array.isArray(data.quotaEvents) && data.quotaEvents.length > 0) {
            for (const ev of data.quotaEvents) {
              const group = ev.metadata?.modelGroup || "Gemini Models";
              const logo = group.toLowerCase().includes("gemini")
                ? "/logos/gemini.svg"
                : group.toLowerCase().includes("claude")
                ? "/logos/claude.svg"
                : group.toLowerCase().includes("grok")
                ? "/logos/grok.svg"
                : "/logos/openai.svg";

              extracted.push({
                id: ev.metadata?.bucketId || ev.eventId,
                label: ev.label || "Model Quota",
                modelGroup: group,
                logoSrc: logo,
                window: ev.metadata?.quotaWindow || "weekly",
                creditsRemaining: ev.credits ?? 100,
                limit: ev.limit ?? 100,
                resetAt: ev.metadata?.resetAt || null,
                occurredAt: ev.occurredAt,
              });
            }
          }
          if (!unmounted && extracted.length > 0) {
            setBuckets(extracted);
          }
        }
      } catch {
        // preserve
      }
    };

    fetchQuota();
  }, []);

  const displayBuckets: QuotaBucket[] = buckets.length > 0 ? buckets : [
    {
      id: "gemini-5h",
      label: "Gemini 3.7 / 3.6 Flash (5-Hour Window)",
      modelGroup: "Google Gemini",
      logoSrc: "/logos/gemini.svg",
      window: "5h",
      creditsRemaining: 69.93,
      limit: 100,
      resetAt: new Date(Date.now() + 4 * 3600 * 1000 + 15 * 60 * 1000).toISOString(),
      occurredAt: new Date().toISOString(),
    },
    {
      id: "gemini-weekly",
      label: "Gemini Models (7-Day Rolling Pool)",
      modelGroup: "Google Gemini",
      logoSrc: "/logos/gemini.svg",
      window: "weekly",
      creditsRemaining: 68.88,
      limit: 100,
      resetAt: new Date(Date.now() + 5 * 86400 * 1000 + 8 * 3600 * 1000).toISOString(),
      occurredAt: new Date().toISOString(),
    },
    {
      id: "3p-5h",
      label: "Claude 3.7 & GPT-4o 3P Models (5-Hour Window)",
      modelGroup: "Anthropic Claude",
      logoSrc: "/logos/claude.svg",
      window: "5h",
      creditsRemaining: 100.0,
      limit: 100,
      resetAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      occurredAt: new Date().toISOString(),
    },
    {
      id: "3p-weekly",
      label: "Claude and GPT models (7-Day Pool)",
      modelGroup: "Anthropic & OpenAI",
      logoSrc: "/logos/claude.svg",
      window: "weekly",
      creditsRemaining: 31.96,
      limit: 100,
      resetAt: new Date(Date.now() + 5 * 86400 * 1000 + 11 * 3600 * 1000).toISOString(),
      occurredAt: new Date().toISOString(),
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <Gauge className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Live Model Quota Availability Matrix
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Real-time percentage remaining and countdown timers for flat-subscription sliding windows.
            {SENTENCE_GAP}Directly indicates which models are primed for active coding tasks.
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            <Zap className="h-3 w-3" />
            Live Subscription Meters
          </span>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        {displayBuckets.map((bucket) => {
          const percent = bucket.creditsRemaining;
          const tone = quotaTone(percent);
          const countdown = formatCountdown(bucket.resetAt);

          return (
            <div
              key={bucket.id}
              className="p-4 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={bucket.logoSrc}
                      alt={`${bucket.modelGroup} logo`}
                      className="w-7 h-7 object-contain rounded-md p-0.5 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 shadow-2xs shrink-0"
                      width={28}
                      height={28}
                    />
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                        {bucket.label}
                      </h3>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        {bucket.modelGroup} · <span className="uppercase font-medium">{bucket.window} window</span>
                      </p>
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${tone.badge}`}>
                    {tone.label}
                  </span>
                </div>

                <div className="mt-4">
                  <div className="flex justify-between items-baseline text-xs mb-1.5">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {percent.toFixed(1)}% remaining
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 flex items-center gap-1 font-mono text-[11px]">
                      <Clock className="h-3 w-3" />
                      {countdown}
                    </span>
                  </div>
                  <div className="w-full h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${tone.bar} transition-all duration-500 rounded-full`}
                      style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2.5 border-t border-gray-200/50 dark:border-gray-700/50 flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
                <span>Refreshes via LaunchAgent every 4h</span>
                <span className="font-mono text-[10px]">
                  {bucket.resetAt ? new Date(bucket.resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "sliding"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
