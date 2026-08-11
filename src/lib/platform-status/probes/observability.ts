/**
 * Observability probes — "is anything screaming at us right now".
 *
 * Three platforms answer three different questions:
 *  - Sentry: are there unresolved errors in any fleet project?
 *  - UptimeRobot: is every public endpoint answering?
 *  - PagerDuty: is anyone being paged right now?
 *
 * Sentry reuses `@/lib/sentry-health`, which already fetches per-project
 * unresolved counts for the dashboard's Sentry card — this probe renders that
 * same summary as a platform card rather than issuing its own requests.  The
 * other two are new read-only integrations and go through `requestJson`, which
 * carries the adapter stack's HTTPS-only, size-bounded, timeout-bounded rules.
 *
 * Related context: `src/app/api/openrouter-credits/route.ts` is the public
 * keyword endpoint UptimeRobot polls for OpenRouter credit exhaustion, so a
 * down monitor here can mean "the money probe went dark", not just "a page is
 * slow".
 *
 * Nothing credential-shaped is rendered.  UptimeRobot in particular echoes the
 * offending value back in its `error.passed_value` field on a bad key — that
 * field is never read into a metric or headline.
 */

import { fetchSentryHealth, isSentryHealthConfigured } from "@/lib/sentry-health";
import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  finiteNumber,
  formatAge,
  formatCount,
  formatPercent,
  hasEnv,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import {
  MAX_PLATFORM_METRICS,
  type PlatformMetric,
  type PlatformProbe,
  type PlatformProbeResult,
} from "../types";

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

async function probeSentry(): Promise<PlatformProbeResult> {
  try {
    const health = await fetchSentryHealth();
    if (!health.configured) {
      // Only reachable if the token disappeared between isConfigured() and here.
      return {
        state: "unavailable",
        headline: "Sentry credentials are no longer readable.",
        metrics: [],
        error: "not_configured",
      };
    }

    const projects = health.projects;
    const readable = projects.filter((project) => !project.error);
    const failed = projects.length - readable.length;
    const total = readable.reduce((sum, project) => sum + project.unresolvedCount, 0);
    const affected = readable.filter((project) => project.unresolvedCount > 0).length;
    const anyMore = readable.some((project) => project.hasMore);

    const metrics: PlatformMetric[] = [
      metric(
        "Unresolved Issues",
        anyMore ? `${total.toLocaleString("en-US")}+ issues` : formatCount(total, "issue"),
        "last 14 days"
      ),
      ...projects.map((project) =>
        project.error
          ? metric(project.displayName, "Unavailable", "read failed")
          : metric(
              project.displayName,
              project.hasMore
                ? `${project.unresolvedCount.toLocaleString("en-US")}+ issues`
                : formatCount(project.unresolvedCount, "issue")
            )
      ),
    ].slice(0, MAX_PLATFORM_METRICS);

    if (failed > 0 && readable.length === 0) {
      return {
        state: "unavailable",
        headline: "Sentry issue counts could not be read.  Check the read token.",
        metrics: [],
        error: "read_failed",
      };
    }

    const readFailureSentence =
      failed > 0 ? `  ${failed} project ${failed === 1 ? "read" : "reads"} failed.` : "";

    if (total > 0) {
      return {
        state: "degraded",
        headline:
          `${formatCount(total, "unresolved issue")} across ${affected} of ` +
          `${readable.length} ${readable.length === 1 ? "project" : "projects"}.` +
          readFailureSentence,
        metrics,
        ...(failed > 0 ? { error: "partial_read" } : {}),
      };
    }

    if (failed > 0) {
      return {
        state: "degraded",
        headline: `No unresolved issues in the projects that answered.${readFailureSentence}`,
        metrics,
        error: "partial_read",
      };
    }

    return {
      state: "healthy",
      headline: `No unresolved issues across ${readable.length} tracked ${
        readable.length === 1 ? "project" : "projects"
      }.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Sentry could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// UptimeRobot
// ---------------------------------------------------------------------------

const UPTIMEROBOT_MONITORS_URL = "https://api.uptimerobot.com/v2/getMonitors";
/** Uptime window requested from UptimeRobot, in days. */
const UPTIMEROBOT_RATIO_DAYS = 30;
/** UptimeRobot caps `limit` at 50 per page; one page is plenty for this fleet. */
const UPTIMEROBOT_PAGE_LIMIT = 50;

/** v2 monitor status codes.  Anything else is treated as "not checked yet". */
const UPTIMEROBOT_PAUSED = 0;
const UPTIMEROBOT_UP = 2;
const UPTIMEROBOT_SEEMS_DOWN = 8;
const UPTIMEROBOT_DOWN = 9;

/** First uptime ratio in UptimeRobot's comma-separated `custom_uptime_ratio`. */
function firstRatio(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const head = raw.split(",")[0]?.trim();
  if (!head) return null;
  const parsed = Number(head);
  return Number.isFinite(parsed) ? parsed : null;
}

async function probeUptimeRobot(): Promise<PlatformProbeResult> {
  const apiKey = envValue("UPTIMEROBOT_API_KEY");
  if (!apiKey) {
    return {
      state: "unavailable",
      headline: "UptimeRobot credentials are no longer readable.",
      metrics: [],
      error: "not_configured",
    };
  }

  try {
    const body = new URLSearchParams({
      api_key: apiKey,
      format: "json",
      custom_uptime_ratios: String(UPTIMEROBOT_RATIO_DAYS),
      limit: String(UPTIMEROBOT_PAGE_LIMIT),
    });

    const response = await requestJson(UPTIMEROBOT_MONITORS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      return upstreamFailure(response.status, "UptimeRobot did not return monitor status.");
    }

    const payload = asRecord(response.data);
    if (!payload) {
      return {
        state: "degraded",
        headline: "UptimeRobot returned an unexpected response.",
        metrics: [],
        error: "invalid_response",
      };
    }

    // UptimeRobot answers HTTP 200 with `stat: "fail"` for a rejected key.  Its
    // error object echoes the submitted value, so only the parameter name is
    // ever inspected and none of it is rendered.
    if (payload.stat !== "ok") {
      const failure = asRecord(payload.error);
      const parameter = typeof failure?.parameter_name === "string" ? failure.parameter_name : "";
      const keyRejected = parameter === "api_key";
      return {
        state: keyRejected ? "unavailable" : "degraded",
        headline: keyRejected
          ? "UptimeRobot rejected the API key."
          : "UptimeRobot rejected the monitor request.",
        metrics: [],
        error: keyRejected ? "unauthorized" : "upstream_error",
      };
    }

    const monitors = asArray(payload.monitors).map(asRecord);
    const returned = monitors.length;
    const reportedTotal = finiteNumber(asRecord(payload.pagination)?.total) ?? returned;

    let up = 0;
    let down = 0;
    let paused = 0;
    let pending = 0;
    let ratioSum = 0;
    let ratioCount = 0;
    const downNames: string[] = [];

    for (const monitor of monitors) {
      const status = finiteNumber(monitor?.status);
      const ratio = firstRatio(monitor?.custom_uptime_ratio);
      if (ratio !== null && status !== UPTIMEROBOT_PAUSED) {
        ratioSum += ratio;
        ratioCount += 1;
      }
      if (status === UPTIMEROBOT_UP) up += 1;
      else if (status === UPTIMEROBOT_DOWN || status === UPTIMEROBOT_SEEMS_DOWN) {
        down += 1;
        const name = typeof monitor?.friendly_name === "string" ? monitor.friendly_name.trim() : "";
        if (name) downNames.push(name);
      } else if (status === UPTIMEROBOT_PAUSED) paused += 1;
      else pending += 1;
    }

    if (returned === 0) {
      return {
        state: "degraded",
        headline: "UptimeRobot has no monitors configured.",
        metrics: [metric("Monitors", formatCount(0, "monitor"))],
      };
    }

    const partial = reportedTotal > returned;
    const averageRatio = ratioCount > 0 ? ratioSum / ratioCount : null;
    const monitorHints = [
      partial ? `first ${returned} of ${reportedTotal}` : null,
      pending > 0 ? `${pending} not checked yet` : null,
    ].filter((hint): hint is string => hint !== null);

    const metrics: PlatformMetric[] = [
      metric(
        "Monitors",
        formatCount(returned, "monitor"),
        monitorHints.length > 0 ? monitorHints.join(", ") : undefined
      ),
      metric("Up", String(up)),
      metric("Down", String(down), downNames.length > 0 ? downNames.join(", ") : undefined),
      metric("Paused", String(paused)),
      metric("Uptime", formatPercent(averageRatio, 2), `${UPTIMEROBOT_RATIO_DAYS}-day average`),
    ];

    if (down > 0) {
      return {
        state: "degraded",
        headline: `${down} of ${returned} monitors ${down === 1 ? "is" : "are"} down.`,
        metrics,
      };
    }

    return {
      state: "healthy",
      headline:
        paused > 0
          ? `${up} of ${returned} monitors are up.  ${paused} paused.`
          : `All ${returned} monitors are up.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "UptimeRobot could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// PagerDuty
// ---------------------------------------------------------------------------

const PAGERDUTY_INCIDENTS_URL =
  "https://api.pagerduty.com/incidents?statuses[]=triggered&statuses[]=acknowledged&limit=100&total=true";

async function probePagerDuty(): Promise<PlatformProbeResult> {
  const apiKey = envValue("PAGERDUTY_API_KEY");
  if (!apiKey) {
    return {
      state: "unavailable",
      headline: "PagerDuty credentials are no longer readable.",
      metrics: [],
      error: "not_configured",
    };
  }

  try {
    const response = await requestJson(PAGERDUTY_INCIDENTS_URL, {
      method: "GET",
      headers: {
        authorization: `Token token=${apiKey}`,
        accept: "application/vnd.pagerduty+json;version=2",
      },
    });

    if (!response.ok) {
      return upstreamFailure(
        response.status,
        response.status === 401 || response.status === 403
          ? "PagerDuty rejected the API key."
          : "PagerDuty did not return open incidents."
      );
    }

    const payload = asRecord(response.data);
    if (!payload) {
      return {
        state: "degraded",
        headline: "PagerDuty returned an unexpected response.",
        metrics: [],
        error: "invalid_response",
      };
    }

    const incidents = asArray(payload.incidents).map(asRecord);
    // `more: true` means the open-incident list is longer than one page, so
    // every non-zero count below is a floor rather than an exact total.
    const truncated = payload.more === true;
    const atLeast = (count: number): string => (truncated && count > 0 ? "+" : "");

    let triggered = 0;
    let acknowledged = 0;
    let highUrgency = 0;
    let oldestTriggeredAt: number | null = null;

    for (const incident of incidents) {
      const status = typeof incident?.status === "string" ? incident.status : "";
      if (status === "triggered") triggered += 1;
      else if (status === "acknowledged") acknowledged += 1;
      if (incident?.urgency === "high") highUrgency += 1;
      if (status === "triggered" && typeof incident?.created_at === "string") {
        const createdMs = Date.parse(incident.created_at);
        if (Number.isFinite(createdMs) && (oldestTriggeredAt === null || createdMs < oldestTriggeredAt)) {
          oldestTriggeredAt = createdMs;
        }
      }
    }

    const metrics: PlatformMetric[] = [
      metric("Triggered", `${formatCount(triggered, "incident")}${atLeast(triggered)}`),
      metric("Acknowledged", `${formatCount(acknowledged, "incident")}${atLeast(acknowledged)}`),
      metric("High Urgency", `${highUrgency}${atLeast(highUrgency)}`),
    ];
    if (oldestTriggeredAt !== null) {
      metrics.push(
        metric("Oldest Triggered", formatAge(new Date(oldestTriggeredAt).toISOString()))
      );
    }

    if (triggered > 0) {
      const acknowledgedSentence =
        acknowledged > 0
          ? `  ${acknowledged}${atLeast(acknowledged)} more ${
              acknowledged === 1 ? "is" : "are"
            } acknowledged.`
          : "";
      return {
        state: "degraded",
        headline:
          `${triggered}${atLeast(triggered)} ${
            triggered === 1 ? "incident is" : "incidents are"
          } triggered.` + acknowledgedSentence,
        metrics,
      };
    }

    return {
      state: "healthy",
      headline:
        acknowledged > 0
          ? `No triggered incidents.  ${acknowledged}${atLeast(
              acknowledged
            )} acknowledged and being worked.`
          : "No open incidents.",
      metrics,
    };
  } catch (error) {
    return failureResult(error, "PagerDuty could not be reached.");
  }
}

// ---------------------------------------------------------------------------

export const OBSERVABILITY_PROBES: readonly PlatformProbe[] = [
  {
    id: "sentry",
    name: "Sentry",
    category: "observability",
    // SENTRY_ORG is listed so an unconfigured card names it, but sentry-health
    // defaults the org, so the token alone is what gates the probe.
    requiredEnv: ["SENTRY_READ_TOKEN", "SENTRY_ORG"],
    consoleUrl: "https://sentry.io/",
    isConfigured: () => isSentryHealthConfigured(),
    probe: probeSentry,
  },
  {
    id: "uptimerobot",
    name: "UptimeRobot",
    category: "observability",
    requiredEnv: ["UPTIMEROBOT_API_KEY"],
    consoleUrl: "https://dashboard.uptimerobot.com/monitors",
    isConfigured: () => hasEnv("UPTIMEROBOT_API_KEY"),
    probe: probeUptimeRobot,
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    category: "observability",
    requiredEnv: ["PAGERDUTY_API_KEY"],
    consoleUrl: "https://app.pagerduty.com/incidents",
    isConfigured: () => hasEnv("PAGERDUTY_API_KEY"),
    probe: probePagerDuty,
  },
];
