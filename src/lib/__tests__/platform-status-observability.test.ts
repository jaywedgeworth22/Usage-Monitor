import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Network is stubbed at the adapter boundary (`fetchJson`) so no probe test
 * ever opens a socket.  Sentry is stubbed one level higher because its probe
 * deliberately reuses `sentry-health` rather than re-implementing that fetch;
 * `isSentryHealthConfigured` stays real (the factories spread the original
 * module) so the unconfigured assertions exercise the actual env check.
 */
vi.mock("@/lib/adapters/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/helpers")>();
  return { ...actual, fetchJson: vi.fn() };
});

vi.mock("@/lib/sentry-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry-health")>();
  return { ...actual, fetchSentryHealth: vi.fn() };
});

import { fetchJson } from "@/lib/adapters/helpers";
import { OBSERVABILITY_PROBES } from "@/lib/platform-status/probes/observability";
import type { PlatformProbe } from "@/lib/platform-status/types";
import {
  fetchSentryHealth,
  type SentryHealthSummary,
  type SentryProjectHealth,
} from "@/lib/sentry-health";

const fetchJsonMock = vi.mocked(fetchJson);
const fetchSentryHealthMock = vi.mocked(fetchSentryHealth);

function probeFor(id: string): PlatformProbe {
  const probe = OBSERVABILITY_PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`missing probe: ${id}`);
  return probe;
}

/** Same shape the real `fetchJson` resolves with. */
function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers({ "content-type": "application/json" }),
  };
}

function requestHeaders(index = 0): Record<string, string> {
  return (fetchJsonMock.mock.calls[index]?.[1]?.headers ?? {}) as Record<string, string>;
}

function sentryProject(
  overrides: Partial<SentryProjectHealth> & Pick<SentryProjectHealth, "projectSlug" | "displayName">
): SentryProjectHealth {
  return {
    unresolvedCount: 0,
    hasMore: false,
    issuesUrl: "https://sentry.io/organizations/jays-services/issues/",
    ...overrides,
  };
}

function sentrySummary(projects: SentryProjectHealth[]): SentryHealthSummary {
  return {
    configured: true,
    org: "jays-services",
    projects,
    fetchedAt: "2026-08-11T12:00:00.000Z",
  };
}

function clearObservabilityEnv() {
  vi.stubEnv("SENTRY_READ_TOKEN", "");
  vi.stubEnv("SENTRY_ORG", "");
  vi.stubEnv("UPTIMEROBOT_API_KEY", "");
  vi.stubEnv("PAGERDUTY_API_KEY", "");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  fetchJsonMock.mockReset();
  fetchSentryHealthMock.mockReset();
  fetchJsonMock.mockImplementation(async () => {
    throw new Error("unexpected fetchJson call");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("OBSERVABILITY_PROBES registry shape", () => {
  it("exposes exactly the three observability platforms", () => {
    expect(OBSERVABILITY_PROBES.map((probe) => probe.id)).toEqual([
      "sentry",
      "uptimerobot",
      "pagerduty",
    ]);
    for (const probe of OBSERVABILITY_PROBES) {
      expect(probe.category).toBe("observability");
      expect(probe.requiredEnv.length).toBeGreaterThan(0);
      expect(probe.consoleUrl).toMatch(/^https:\/\//);
    }
  });

  it("reports every platform unconfigured when no env is set", () => {
    clearObservabilityEnv();
    for (const probe of OBSERVABILITY_PROBES) {
      expect(probe.isConfigured()).toBe(false);
    }
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(fetchSentryHealthMock).not.toHaveBeenCalled();
  });
});

describe("sentry probe", () => {
  it("is configured once the read token is present", () => {
    clearObservabilityEnv();
    expect(probeFor("sentry").isConfigured()).toBe(false);
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    expect(probeFor("sentry").isConfigured()).toBe(true);
  });

  it("reports healthy when every tracked project has zero unresolved issues", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    vi.stubEnv("SENTRY_ORG", "jays-services");
    fetchSentryHealthMock.mockResolvedValue(
      sentrySummary([
        sentryProject({
          projectSlug: "usage-monitor",
          displayName: "Usage Monitor (this app)",
        }),
        sentryProject({ projectSlug: "socratic-trade", displayName: "Socratic Trade" }),
      ])
    );

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("No unresolved issues across 2 tracked projects.");
    expect(result.error).toBeUndefined();

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Unresolved Issues")?.value).toBe("0 issues");
    expect(byLabel.get("Socratic Trade")?.value).toBe("0 issues");
  });

  it("degrades when any project has unresolved issues and names the failed reads", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    fetchSentryHealthMock.mockResolvedValue(
      sentrySummary([
        sentryProject({
          projectSlug: "usage-monitor",
          displayName: "Usage Monitor (this app)",
          unresolvedCount: 3,
        }),
        sentryProject({ projectSlug: "congress-trade", displayName: "Congress Trade" }),
        sentryProject({
          projectSlug: "fleet-infra",
          displayName: "Fleet Infra",
          error: "HTTP 500",
        }),
      ])
    );

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("degraded");
    expect(result.headline).toBe(
      "3 unresolved issues across 1 of 2 projects.  1 project read failed."
    );
    expect(result.error).toBe("partial_read");

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Unresolved Issues")?.value).toBe("3 issues");
    expect(byLabel.get("Fleet Infra")?.value).toBe("Unavailable");
    // Upstream error text is never rendered onto the card.
    expect(JSON.stringify(result)).not.toContain("HTTP 500");
  });

  it("reports unavailable when no project could be read", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    fetchSentryHealthMock.mockResolvedValue(
      sentrySummary([
        sentryProject({
          projectSlug: "usage-monitor",
          displayName: "Usage Monitor (this app)",
          error: "HTTP 403",
        }),
      ])
    );

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("read_failed");
    expect(result.metrics).toEqual([]);
  });

  it("returns unreachable rather than throwing when the health read explodes", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    fetchSentryHealthMock.mockRejectedValue(new Error("socket hang up"));

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("unreachable");
    expect(result.headline).toBe("Sentry could not be reached.");
  });
});

describe("uptimerobot probe", () => {
  const healthyPayload = {
    stat: "ok",
    pagination: { offset: 0, limit: 50, total: 3 },
    monitors: [
      {
        id: 800_100_001,
        friendly_name: "Usage Monitor health",
        status: 2,
        custom_uptime_ratio: "100.000",
      },
      {
        id: 800_100_002,
        friendly_name: "OpenRouter credits probe",
        status: 2,
        custom_uptime_ratio: "99.980",
      },
      {
        id: 800_100_003,
        friendly_name: "Legacy staging",
        status: 0,
        custom_uptime_ratio: "0.000",
      },
    ],
  };

  it("is unconfigured without UPTIMEROBOT_API_KEY", () => {
    clearObservabilityEnv();
    expect(probeFor("uptimerobot").isConfigured()).toBe(false);
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    expect(probeFor("uptimerobot").isConfigured()).toBe(true);
  });

  it("parses a healthy monitor list and never echoes the API key", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(jsonResponse(200, healthyPayload));

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("2 of 3 monitors are up.  1 paused.");
    expect(result.error).toBeUndefined();

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Monitors")?.value).toBe("3 monitors");
    expect(byLabel.get("Up")?.value).toBe("2");
    expect(byLabel.get("Down")?.value).toBe("0");
    expect(byLabel.get("Paused")?.value).toBe("1");
    // Paused monitors are excluded from the ratio average: (100 + 99.98) / 2.
    expect(byLabel.get("Uptime")?.value).toBe("99.99%");
    expect(byLabel.get("Uptime")?.hint).toBe("30-day average");
    expect(JSON.stringify(result)).not.toContain("u800100-testkey");

    expect(fetchJsonMock.mock.calls[0][0]).toBe("https://api.uptimerobot.com/v2/getMonitors");
    expect(fetchJsonMock.mock.calls[0][1]?.method).toBe("POST");
    expect(String(fetchJsonMock.mock.calls[0][1]?.body)).toContain("format=json");
  });

  it("degrades and names the down count when a monitor is down", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        stat: "ok",
        pagination: { offset: 0, limit: 50, total: 2 },
        monitors: [
          {
            id: 800_100_001,
            friendly_name: "Usage Monitor health",
            status: 2,
            custom_uptime_ratio: "99.900",
          },
          {
            id: 800_100_002,
            friendly_name: "OpenRouter credits probe",
            status: 9,
            custom_uptime_ratio: "97.500",
          },
        ],
      })
    );

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("degraded");
    expect(result.headline).toBe("1 of 2 monitors is down.");

    const down = result.metrics.find((entry) => entry.label === "Down");
    expect(down?.value).toBe("1");
    expect(down?.hint).toBe("OpenRouter credits probe");
  });

  it("maps a rejected API key reported inside a 200 body to unavailable", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-badkey");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        stat: "fail",
        error: {
          type: "invalid_parameter",
          parameter_name: "api_key",
          passed_value: "u800100-badkey",
          message: "api_key is not valid",
        },
      })
    );

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("unauthorized");
    expect(result.headline).toBe("UptimeRobot rejected the API key.");
    expect(result.metrics).toEqual([]);
    // UptimeRobot echoes the submitted key back in `passed_value`.
    expect(JSON.stringify(result)).not.toContain("u800100-badkey");
  });

  it("maps a non-ok HTTP response to a rate-limited degraded card", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(jsonResponse(429, { stat: "fail" }));

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("degraded");
    expect(result.error).toBe("rate_limited");
    expect(result.metrics).toEqual([]);
  });

  it("returns unreachable rather than throwing on a transport failure", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockRejectedValue(new Error("Request to https://api.uptimerobot.com timed out"));

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("timeout");
  });
});

describe("pagerduty probe", () => {
  it("is unconfigured without PAGERDUTY_API_KEY", () => {
    clearObservabilityEnv();
    expect(probeFor("pagerduty").isConfigured()).toBe(false);
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    expect(probeFor("pagerduty").isConfigured()).toBe(true);
  });

  it("reports healthy with no open incidents and sends v2 auth headers", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, { incidents: [], limit: 100, offset: 0, more: false, total: 0 })
    );

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("No open incidents.");
    expect(result.metrics.find((entry) => entry.label === "Triggered")?.value).toBe("0 incidents");
    expect(JSON.stringify(result)).not.toContain("pagerduty-fixture-token");

    expect(String(fetchJsonMock.mock.calls[0][0])).toContain("https://api.pagerduty.com/incidents");
    expect(requestHeaders().accept).toBe("application/vnd.pagerduty+json;version=2");
    expect(requestHeaders().authorization).toBe("Token token=pagerduty-fixture-token");
  });

  it("degrades on a triggered incident and ages it against a frozen clock", async () => {
    // The clock is frozen because "Oldest Triggered" renders a relative age.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        incidents: [
          {
            id: "PT4KHLK",
            status: "triggered",
            urgency: "high",
            created_at: "2026-08-11T09:30:00Z",
            title: "Usage Monitor 5xx spike",
          },
          {
            id: "PT4KHLM",
            status: "triggered",
            urgency: "low",
            created_at: "2026-08-11T11:45:00Z",
            title: "Backup lag",
          },
          {
            id: "PT4KHLN",
            status: "acknowledged",
            urgency: "high",
            created_at: "2026-08-11T08:00:00Z",
            title: "Coolify restart loop",
          },
        ],
        limit: 100,
        offset: 0,
        more: false,
        total: 3,
      })
    );

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("degraded");
    expect(result.headline).toBe("2 incidents are triggered.  1 more is acknowledged.");

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Triggered")?.value).toBe("2 incidents");
    expect(byLabel.get("Acknowledged")?.value).toBe("1 incident");
    expect(byLabel.get("High Urgency")?.value).toBe("2");
    expect(byLabel.get("Oldest Triggered")?.value).toBe("2h ago");
    // Incident titles are upstream text and never reach the card.
    expect(JSON.stringify(result)).not.toContain("5xx spike");
  });

  it("maps a rejected key to unavailable/unauthorized", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "y_badkey");
    fetchJsonMock.mockResolvedValue(jsonResponse(401, { error: { code: 2006 } }));

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("unauthorized");
    expect(result.headline).toBe("PagerDuty rejected the API key.");
    expect(result.metrics).toEqual([]);
  });

  it("maps a 500 to a degraded upstream error", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockResolvedValue(jsonResponse(500, null));

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("degraded");
    expect(result.error).toBe("upstream_error");
  });

  it("returns unreachable rather than throwing on a transport failure", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockRejectedValue(new Error("network error"));

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("unreachable");
  });
});
