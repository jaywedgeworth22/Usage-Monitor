import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSentryFleetDsnForTests,
  isSentryFleetConfigured,
  recordFleetInfraEvent,
  recordFleetInfraMetric,
} from "@/lib/sentry-fleet";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetSentryFleetDsnForTests();
  delete process.env.SENTRY_FLEET_DSN;
  process.env.SENTRY_FLEET_DEBUG = "true";
  process.env.AGENT_TAG = "MM";
});

afterEach(() => {
  __resetSentryFleetDsnForTests();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("sentry-fleet DSN configuration", () => {
  it("is unconfigured when SENTRY_FLEET_DSN is absent", () => {
    expect(isSentryFleetConfigured()).toBe(false);
  });

  it("parses the canonical Sentry DSN shape and is configured", () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    expect(isSentryFleetConfigured()).toBe(true);
  });

  it("strips the /serverdsn suffix Sentry sometimes appends", () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42/serverdsn";
    expect(isSentryFleetConfigured()).toBe(true);
  });

  it("rejects a malformed DSN and disables emit", () => {
    process.env.SENTRY_FLEET_DSN = "not-a-dsn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isSentryFleetConfigured()).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("rejects a DSN with a non-hex public key", () => {
    process.env.SENTRY_FLEET_DSN =
      "https://not_hex_key@o0.ingest.sentry.io/42";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isSentryFleetConfigured()).toBe(false);
  });
});

describe("recordFleetInfraEvent", () => {
  it("is a no-op when SENTRY_FLEET_DSN is absent", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraEvent("scheduler.tick", {
      app: "usage-monitor",
      agent: "MM",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs a Sentry envelope to the DSN-derived endpoint", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraEvent(
      "scheduler.tick",
      {
        app: "usage-monitor",
        agent: "MM",
        "metric.name": "scheduler.tick",
      },
      { level: "info", extra: { value: 1 } }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toBe(
      "https://o0.ingest.sentry.io/api/42/envelope/?sentry_key=abcd1234567890abcd&sentry_version=7"
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/x-sentry-envelope",
    });
    const body = String(init?.body ?? "");
    // Envelope is newline-delimited: header, item-header, event, "".
    const lines = body.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const envelopeHeader = JSON.parse(lines[0]);
    expect(envelopeHeader.sent_at).toBeTruthy();
    expect(envelopeHeader.sdk).toMatchObject({ name: "sentry.jays.services.um-fleet" });
    const itemHeader = JSON.parse(lines[1]);
    expect(itemHeader).toMatchObject({
      type: "event",
      content_type: "application/json",
    });
    const event = JSON.parse(lines[2]);
    expect(event.tags).toMatchObject({
      app: "usage-monitor",
      agent: "MM",
    });
    expect(event.message).toBe("scheduler.tick");
    expect(event.level).toBe("info");
    // The envelope header carries the public key in trace.public_key (Sentry's
    // wire format for envelope routing — required, not a leak).  The URL
    // already pins the host and project id.  What we additionally verify:
    // the DSN string, the host, and the project id do not appear in the
    // request body beyond the trace envelope header.
    const bodyMinusHeader = lines.slice(2).join("\n");
    expect(bodyMinusHeader).not.toContain("ingest.sentry.io");
    expect(bodyMinusHeader).not.toContain('"42"');
  });

  it("swallows fetch failures and never throws", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(
      recordFleetInfraEvent("scheduler.tick", {
        app: "usage-monitor",
        agent: "MM",
      })
    ).resolves.toBeUndefined();
  });
});

describe("recordFleetInfraMetric", () => {
  it("stamps the app + agent + metric tags and a counter fingerprint", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("scheduler.tick", 1, {
      total: 10,
      successes: 9,
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const body = String(init?.body ?? "");
    const lines = body.split("\n");
    const event = JSON.parse(lines[2]);
    expect(event.tags).toMatchObject({
      app: "usage-monitor",
      agent: "MM",
      "metric.name": "scheduler.tick",
      "metric.kind": "counter",
      "metric.total": "10",
      "metric.successes": "9",
    });
    expect(event.fingerprint).toEqual(["um-fleet", "metric", "scheduler.tick"]);
    expect(event.extra).toMatchObject({ "metric.value": 1 });
  });

  it("marks warning level for metrics containing _rejected in any segment", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("ingest.admission_rejected", 1, { route: "ingest/usage" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const lines = String(init?.body ?? "").split("\n");
    const event = JSON.parse(lines[2]);
    expect(event.level).toBe("warning");
  });

  it("marks warning level for .failed and .error metrics", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("ingest.failed", 1, { reason: "TypeError" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const lines = String(init?.body ?? "").split("\n");
    expect(JSON.parse(lines[2]).level).toBe("warning");
  });

  it("treats non-integer values as gauges", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("scheduler.duration_ms", 1234.5, { outcome: "ok" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const lines = String(init?.body ?? "").split("\n");
    const event = JSON.parse(lines[2]);
    expect(event.tags["metric.kind"]).toBe("gauge");
    expect(event.extra).toMatchObject({ "metric.value": 1234.5 });
  });
});
