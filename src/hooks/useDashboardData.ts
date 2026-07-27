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

/** Must exceed the per-request AbortSignal.timeout (30s) so normal timeouts win first. */
export const DASHBOARD_LOAD_WATCHDOG_MS = 35_000;

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

/**
 * Compose a timeout signal with an optional external (unmount) signal.
 * Feature-detect AbortSignal.any — older WebKit throws if called bare, and a
 * sync throw *outside* fetchJson's try used to reject before the route timeout
 * path could run.
 */
export function combineAbortSignals(
  timeout: AbortSignal,
  external?: AbortSignal | null
): AbortSignal {
  if (external == null) return timeout;
  if (typeof AbortSignal.any !== "function") return timeout;
  try {
    return AbortSignal.any([timeout, external]);
  } catch {
    return timeout;
  }
}

async function fetchJson<T>(url: string, label: string, signal?: AbortSignal): Promise<T> {
  // 30s matches main (#816); compose with unmount abort so remounts cannot
  // inherit a stuck in-flight request.
  try {
    const timeout =
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(30_000)
        : undefined;
    const combined =
      timeout != null ? combineAbortSignals(timeout, signal) : signal;
    const response = await fetch(url, {
      cache: "no-store",
      ...(combined != null ? { signal: combined } : {}),
    });
    if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("Session expired. Redirecting to login...");
    }
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      // Cloudflare managed challenges return HTML 403; surface a clear retry
      // instead of a generic parse/empty-body failure.
      if (contentType.includes("text/html")) {
        throw new Error(
          `Failed to fetch ${label} (HTTP ${response.status}). A network challenge may be blocking API requests — tap Retry, or reload the page.`
        );
      }
      const body = await response.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error || `Failed to fetch ${label}`
      );
    }
    return (await response.json()) as T;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      message.toLowerCase().includes("aborted") ||
      message.toLowerCase().includes("timed out")
    ) {
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
      const isCurrent = generation === fetchGenerationRef.current;

      // ALWAYS release the coalesce lock — even for stale generations. Skipping
      // this after a freeze/abort (no React cleanup) left isFetchingRef=true
      // forever so every later fetchProviders() coalesced and returned, which
      // is the perpetual-skeleton deadlock after #814.
      isFetchingRef.current = false;

      if (isCurrent) {
        loadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);

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

  // Recover after bfcache restore, tab freeze, or visibility resume when the
  // skeleton is still up. The previous pageshow handler only ran when
  // event.persisted — mobile Safari often resumes without that flag while
  // leaving isFetchingRef stuck true (coalesce deadlock → blank forever).
  useEffect(() => {
    const recoverIfStuck = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      // Healthy dashboards: leave in-flight refresh coalescing alone.
      if (hasProviderData.current && loadedOnce.current) return;
      isFetchingRef.current = false;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
      void fetchProviders({ background: loadedOnce.current });
    };

    window.addEventListener("pageshow", recoverIfStuck);
    const onVisibilityChange = () => {
      if (!document.hidden) recoverIfStuck();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pageshow", recoverIfStuck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchProviders]);

  // Last-resort watchdog: if the initial skeleton is still up past the request
  // timeout, force an error+Retry UI. Covers hung fetches where AbortSignal
  // never fires (background tabs, broken signal composition, CF-held sockets).
  useEffect(() => {
    if (!loading || hasProviderData.current) return;
    const id = window.setTimeout(() => {
      if (hasProviderData.current) return;
      isFetchingRef.current = false;
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
      setError((prev) =>
        prev ||
        "Dashboard load timed out. Please click Retry."
      );
    }, DASHBOARD_LOAD_WATCHDOG_MS);
    return () => window.clearTimeout(id);
  }, [loading]);

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
