"use client";

import { useEffect, useState } from "react";
import CardUnavailableNotice from "@/components/CardUnavailableNotice";

interface SentryProjectHealth {
  projectSlug: string;
  displayName: string;
  unresolvedCount: number;
  hasMore: boolean;
  issuesUrl: string;
  error?: string;
}

interface SentryHealthResponse {
  configured: boolean;
  org?: string;
  projects?: SentryProjectHealth[];
  fetchedAt?: string;
}

// Small read-only card summarizing open Sentry issue counts per tracked
// project, with deep links back into Sentry. Renders nothing at all when
// Sentry isn't configured (SENTRY_READ_TOKEN/SENTRY_ORG unset) so this is
// invisible by default rather than showing an empty/broken card. A failed
// request is NOT the same state: it renders an explicit unavailable notice,
// because a health card that disappears reads as "nothing wrong".
export default function SentryHealthCard() {
  const [data, setData] = useState<SentryHealthResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sentry-health")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then((json: SentryHealthResponse) => {
        if (cancelled) return;
        setData(json);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  if (failed) {
    return (
      <CardUnavailableNotice
        title="Sentry health unavailable."
        detail="Open issue counts could not be loaded."
        onRetry={() => setReloadCount((count) => count + 1)}
      />
    );
  }

  if (!data || !data.configured || !data.projects) return null;

  const totalOpen = data.projects.reduce((sum, p) => sum + p.unresolvedCount, 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Sentry Health
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Open issues, last 14 days · {data.org}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p
            className={`text-sm font-semibold ${
              totalOpen > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-gray-900 dark:text-gray-100"
            }`}
          >
            {totalOpen} open
          </p>
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {data.projects.map((project) => (
          <a
            key={project.projectSlug}
            href={project.issuesUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/40"
          >
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {project.displayName}
            </span>
            {project.error ? (
              <span className="text-xs text-gray-400 dark:text-gray-500">unavailable</span>
            ) : (
              <span
                className={`text-xs font-medium px-2 py-1 rounded-full ${
                  project.unresolvedCount > 0
                    ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                    : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                }`}
              >
                {project.unresolvedCount}
                {project.hasMore ? "+" : ""} unresolved
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
