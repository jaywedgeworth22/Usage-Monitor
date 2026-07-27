"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import type { ProjectBudgetStatus } from "@/components/ProjectsPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";

export interface ProjectBudgetResponse {
  projects: ProjectBudgetStatus[];
  summary: {
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  };
}

/**
 * Full-page skeleton only before the first fetch settles *and* we have nothing
 * to show. Once providers are on screen, later loading/refresh flags must not
 * blank the dashboard (that was the flash-then-stuck-skeleton bug).
 */
export function shouldShowDashboardSkeleton(opts: {
  loading: boolean;
  providerCount: number;
}): boolean {
  return opts.loading && opts.providerCount === 0;
}

async function fetchJson<T>(url: string, label: string, signal?: AbortSignal): Promise<T> {
  // 30s matches main (#816); compose with unmount abort so remounts cannot
  // inherit a stuck in-flight request.
  const timeout = AbortSignal.timeout(30_000);
  const combined =
    signal != null ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await fetch(url, { cache: "no-store", signal: combined });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Failed to fetch ${label}`);
    }
    return (await response.json()) as T;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (name === "AbortError" || message.toLowerCase().includes("aborted")) {
      throw new Error(`Connection timed out loading ${label}. Please click Retry.`);
    }
    throw err;
  }
}

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 15_000;

export function useDashboardData() {
  const [providers, setProviders] = useState<any[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectBudgetResponse["summary"] | null>(null);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);
  const isFetchingRef = useRef(false);
  const pendingForegroundRef = useRef(false);
  const pendingBackgroundRef = useRef(false);
  const lastSuccessAtRef = useRef(0);
  const portfolioFetchInFlightRef = useRef(false);
  const fetchGenerationRef = useRef(0);
  const unmountAbortRef = useRef<AbortController | null>(null);

  const fetchProviders = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;

    // Coalesce overlapping calls onto the in-flight request instead of
    // flipping loading/refreshing UI and returning with nobody owning cleanup.
    if (isFetchingRef.current) {
      if (background) pendingBackgroundRef.current = true;
      else pendingForegroundRef.current = true;
      if (!background && loadedOnce.current) {
        setRefreshing(true);
      }
      return;
    }
    isFetchingRef.current = true;
    const generation = ++fetchGenerationRef.current;

    // Initial useState(true) covers the first paint. Never set loading back to
    // true after that — blanking the page after data appeared is the flash bug.
    if (!background && loadedOnce.current) {
      setRefreshing(true);
    }
    if (!background) {
      setError("");
      setWarnings([]);
    }

    const signal = unmountAbortRef.current?.signal;

    try {
      const [providersResult, subscriptionsResult] = await Promise.allSettled([
        fetchJson<unknown[]>("/api/providers?view=dashboard", "providers", signal),
        fetchJson<SubscriptionRow[]>("/api/subscriptions", "paid services", signal),
      ]);

      // Stale generation after unmount/remount — do not touch UI state.
      if (generation !== fetchGenerationRef.current) return;

      const nextWarnings: string[] = [];
      if (providersResult.status === "fulfilled") {
        setProviders(providersResult.value);
        hasProviderData.current = true;
        setError("");
      } else if (!hasProviderData.current) {
        setError(
          providersResult.reason instanceof Error
            ? providersResult.reason.message
            : "Failed to load providers"
        );
      } else {
        nextWarnings.push("Provider data could not be refreshed; showing the last successful result.");
      }

      if (subscriptionsResult.status === "fulfilled") {
        setSubscriptions(subscriptionsResult.value);
      } else {
        nextWarnings.push("Tracked subscriptions are temporarily unavailable.");
      }

      setWarnings(nextWarnings);
      if (providersResult.status === "fulfilled") {
        setLastUpdatedAt(new Date().toISOString());
        lastSuccessAtRef.current = Date.now();
      }
    } finally {
      if (generation === fetchGenerationRef.current) {
        loadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);
        isFetchingRef.current = false;

        const needForeground = pendingForegroundRef.current;
        const needBackground = pendingBackgroundRef.current;
        pendingForegroundRef.current = false;
        pendingBackgroundRef.current = false;
        if (needForeground) {
          void fetchProviders();
        } else if (needBackground) {
          void fetchProviders({ background: true });
        }
      }
    }
  }, []);

  const fetchPortfolioData = useCallback(async () => {
    if (portfolioFetchInFlightRef.current) return;
    portfolioFetchInFlightRef.current = true;
    setPortfolioLoading(true);
    setPortfolioError("");
    const failures: string[] = [];
    try {
      try {
        setUsageSummary(
          await fetchJson<ExternalUsageSummary>(
            "/api/usage-events?days=30",
            "app telemetry",
            unmountAbortRef.current?.signal
          )
        );
      } catch {
        failures.push("External app telemetry is temporarily unavailable.");
      }
      try {
        const response = await fetchJson<ProjectBudgetResponse>(
          "/api/projects?includeSummary=1",
          "projects",
          unmountAbortRef.current?.signal
        );
        setProjects(response.projects);
        setProjectSummary(response.summary);
      } catch {
        failures.push("Project budgets are temporarily unavailable.");
      }
      setPortfolioError(failures.join(" "));
      setPortfolioLoaded(failures.length === 0);
    } finally {
      setPortfolioLoading(false);
      portfolioFetchInFlightRef.current = false;
    }
  }, []);

  const refreshDashboard = useCallback(async () => {
    await fetchProviders();
    if (portfolioOpen) await fetchPortfolioData();
  }, [fetchPortfolioData, fetchProviders, portfolioOpen]);

  // Initial load + abort in-flight work on unmount so a remount cannot inherit
  // a stuck isFetching guard from a discarded instance.
  useEffect(() => {
    const controller = new AbortController();
    unmountAbortRef.current = controller;
    void fetchProviders();
    return () => {
      fetchGenerationRef.current += 1;
      isFetchingRef.current = false;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
      controller.abort();
      if (unmountAbortRef.current === controller) {
        unmountAbortRef.current = null;
      }
    };
  }, [fetchProviders]);

  // bfcache restore can freeze the page mid-fetch with isFetching=true and
  // never re-run mount effects — reset the guard and refetch.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      isFetchingRef.current = false;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
      void fetchProviders({ background: loadedOnce.current });
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [fetchProviders]);

  // Auto-refresh on interval + focus/visibility
  useEffect(() => {
    const refreshIfDue = () => {
      if (document.hidden) return;
      if (Date.now() - lastSuccessAtRef.current < FOCUS_REFRESH_THROTTLE_MS) return;
      fetchProviders({ background: true });
    };

    const handleIntervalTick = () => {
      if (document.hidden) return;
      fetchProviders({ background: true });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) refreshIfDue();
    };

    const intervalId = window.setInterval(handleIntervalTick, AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfDue);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfDue);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchProviders]);

  // Portfolio auto-refresh when open
  useEffect(() => {
    if (!portfolioOpen) return;
    if (!document.hidden) void fetchPortfolioData();
    const interval = window.setInterval(
      () => {
        if (!document.hidden) void fetchPortfolioData();
      },
      AUTO_REFRESH_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [fetchPortfolioData, portfolioOpen]);

  const openAttentionPanel = useCallback(() => {
    window.requestAnimationFrame(() => {
      document.getElementById("attention")?.scrollIntoView({ block: "start" });
    });
  }, []);

  // Hash-based attention navigation
  useEffect(() => {
    const openIfAttentionHash = () => {
      if (window.location.hash !== "#attention") return;
      openAttentionPanel();
    };
    openIfAttentionHash();
    window.addEventListener("hashchange", openIfAttentionHash);
    return () => window.removeEventListener("hashchange", openIfAttentionHash);
  }, [loading, openAttentionPanel]);

  return {
    providers,
    usageSummary,
    projects,
    subscriptions,
    projectSummary,
    portfolioOpen,
    setPortfolioOpen,
    portfolioLoaded,
    portfolioLoading,
    portfolioError,
    loading,
    refreshing,
    error,
    warnings,
    lastUpdatedAt,
    fetchProviders,
    fetchPortfolioData,
    refreshDashboard,
    openAttentionPanel,
  };
}
