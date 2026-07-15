import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleCloudMonitoring } from "../google-cloud-monitoring";

const REQUEST_COUNT = "serviceruntime.googleapis.com/api/request_count";
const QUOTA_USAGE = "serviceruntime.googleapis.com/quota/rate/net_usage";
const QUOTA_LIMIT = "serviceruntime.googleapis.com/quota/limit";
const PROJECT_ID = "gemini-production";
const SERVICE = "generativelanguage.googleapis.com";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function config() {
  return {
    googleProjectId: PROJECT_ID,
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: "billing-query-project",
      private_key_id: "test-key-id",
      private_key: privateKey,
      client_email:
        "usage-monitor@billing-query-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function point(value: number, endTime = "2026-07-13T20:00:00Z") {
  return {
    interval: { endTime },
    value: { int64Value: String(value) },
  };
}

function series(input: {
  metricType: string;
  resourceType: "consumed_api" | "consumer_quota";
  metricLabels?: Record<string, string>;
  resourceLabels?: Record<string, string>;
  points: Array<ReturnType<typeof point>>;
}) {
  return {
    metric: { type: input.metricType, labels: input.metricLabels ?? {} },
    resource: {
      type: input.resourceType,
      labels: {
        project_id: PROJECT_ID,
        service: SERVICE,
        location: "global",
        ...input.resourceLabels,
      },
    },
    points: input.points,
  };
}

function decodeJwtClaims(body: unknown): Record<string, unknown> {
  const assertion = new URLSearchParams(String(body)).get("assertion");
  expect(assertion).toBeTruthy();
  const encodedClaims = assertion!.split(".")[1];
  return JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
}

function metricFromUrl(value: string): string {
  const filter = new URL(value).searchParams.get("filter") ?? "";
  const match = filter.match(/metric\.type = "([^"]+)"/);
  if (!match) throw new Error(`Missing metric filter: ${filter}`);
  return match[1];
}

function stubMonitoring(
  responder: (metric: string, url: URL) => Response | Promise<Response>
) {
  const fetchMock = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const value = String(input);
      if (value === "https://oauth2.googleapis.com/token") {
        expect(init?.method).toBe("POST");
        const claims = decodeJwtClaims(init?.body);
        expect(claims.scope).toBe(
          "https://www.googleapis.com/auth/monitoring.read"
        );
        expect(String(init?.body)).not.toContain("PRIVATE KEY");
        return Promise.resolve(jsonResponse({ access_token: "monitoring-token" }));
      }
      const url = new URL(value);
      expect(url.origin).toBe("https://monitoring.googleapis.com");
      expect(url.pathname).toBe(
        `/v3/projects/${PROJECT_ID}/timeSeries`
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer monitoring-token"
      );
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(url.searchParams.get("view")).toBe("FULL");
      const filter = url.searchParams.get("filter");
      expect(filter).toContain(
        `resource.labels.service = "${SERVICE}"`
      );
      return Promise.resolve(responder(metricFromUrl(value), url));
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Google Cloud Monitoring Gemini enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T20:30:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads documented request and request/token quota metrics with monitoring.read", async () => {
    const fetchMock = stubMonitoring((metric, url) => {
      if (metric === REQUEST_COUNT) {
        expect(url.searchParams.get("aggregation.perSeriesAligner")).toBe(
          "ALIGN_SUM"
        );
        expect(url.searchParams.get("aggregation.crossSeriesReducer")).toBe(
          "REDUCE_SUM"
        );
        return jsonResponse({
          timeSeries: [
            series({
              metricType: REQUEST_COUNT,
              resourceType: "consumed_api",
              resourceLabels: {
                credential_id: "must-not-be-retained",
                method: "GenerateContent",
              },
              points: [point(10), point(5, "2026-07-12T20:00:00Z")],
            }),
          ],
        });
      }
      if (metric === QUOTA_USAGE) {
        return jsonResponse({
          timeSeries: [
            series({
              metricType: QUOTA_USAGE,
              resourceType: "consumer_quota",
              metricLabels: {
                quota_metric:
                  "generativelanguage.googleapis.com/generate_content_requests",
              },
              points: [point(8)],
            }),
            series({
              metricType: QUOTA_USAGE,
              resourceType: "consumer_quota",
              metricLabels: {
                quota_metric:
                  "generativelanguage.googleapis.com/generate_content_tokens",
              },
              points: [point(1200)],
            }),
            series({
              metricType: QUOTA_USAGE,
              resourceType: "consumer_quota",
              metricLabels: {
                quota_metric: "unrelated.googleapis.com/network_bytes",
              },
              points: [point(999)],
            }),
          ],
        });
      }
      expect(metric).toBe(QUOTA_LIMIT);
      return jsonResponse({
        timeSeries: [
          series({
            metricType: QUOTA_LIMIT,
            resourceType: "consumer_quota",
            metricLabels: {
              quota_metric:
                "generativelanguage.googleapis.com/generate_content_tokens",
              limit_name: "GenerateContentTokensPerMinutePerProject",
            },
            points: [point(2_000_000)],
          }),
        ],
      });
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result).toMatchObject({
      status: "ready",
      projectId: PROJECT_ID,
      totalRequests: 15,
      requests: { status: "ready", total: 15, pointCount: 2 },
      quotaUsage: {
        status: "ready",
        availableCount: 2,
        retainedCount: 2,
        truncated: false,
      },
      quotaLimits: {
        status: "ready",
        availableCount: 1,
        retainedCount: 1,
        truncated: false,
      },
    });
    expect(result.externalBillingSyncs.map((sync) => sync.source)).toEqual([
      "google-cloud-monitoring-requests",
      "google-cloud-monitoring-quota-usage",
      "google-cloud-monitoring-quota-limits",
    ]);
    expect(result.externalBillingSyncs[0].records[0]).toMatchObject({
      usageQuantity: 15,
      usageUnit: "requests",
      rollupRole: "metadata",
    });
    expect(result.externalBillingSyncs[2].records[0]).toMatchObject({
      requestLimit: 2_000_000,
      usageUnit: "tokens",
      rollupRole: "metadata",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
    expect(JSON.stringify(result)).not.toContain("GenerateContent\"");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("authoritatively clears stale metadata when all successful queries are empty", async () => {
    stubMonitoring(() => jsonResponse({ timeSeries: [] }));

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("empty");
    expect(result.totalRequests).toBeNull();
    expect(result.reportThrough).toBeNull();
    expect(result.externalBillingSyncs).toEqual([
      {
        source: "google-cloud-monitoring-requests",
        authoritative: true,
        records: [],
      },
      {
        source: "google-cloud-monitoring-quota-usage",
        authoritative: true,
        records: [],
      },
      {
        source: "google-cloud-monitoring-quota-limits",
        authoritative: true,
        records: [],
      },
    ]);
  });

  it("keeps successful request and limit data when one quota query is forbidden", async () => {
    stubMonitoring((metric) => {
      if (metric === QUOTA_USAGE) {
        return jsonResponse({ error: { status: "PERMISSION_DENIED" } }, 403);
      }
      if (metric === REQUEST_COUNT) {
        return jsonResponse({
          timeSeries: [
            series({
              metricType: REQUEST_COUNT,
              resourceType: "consumed_api",
              points: [point(12)],
            }),
          ],
        });
      }
      return jsonResponse({ timeSeries: [] });
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("partial");
    expect(result.totalRequests).toBe(12);
    expect(result.quotaUsage).toMatchObject({
      status: "error",
      errorCode: "HTTP_ERROR",
      httpStatus: 403,
      retryable: false,
    });
    expect(result.externalBillingSyncs.map((sync) => sync.source)).toEqual([
      "google-cloud-monitoring-requests",
      "google-cloud-monitoring-quota-limits",
    ]);
    expect(result.partialError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
    });
  });

  it("reports project permission denial without returning false zero or clear syncs", async () => {
    stubMonitoring(() =>
      jsonResponse({ error: { status: "PERMISSION_DENIED" } }, 403)
    );

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("permission_denied");
    expect(result.totalRequests).toBeNull();
    expect(result.externalBillingSyncs).toEqual([]);
    expect(result.partialError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });
  });

  it("rejects repeated pagination tokens and preserves successful sibling queries", async () => {
    let requestPage = 0;
    stubMonitoring((metric, url) => {
      if (metric !== REQUEST_COUNT) return jsonResponse({ timeSeries: [] });
      requestPage += 1;
      if (requestPage === 1) {
        expect(url.searchParams.get("pageToken")).toBeNull();
        return jsonResponse({ timeSeries: [], nextPageToken: "repeat" });
      }
      expect(url.searchParams.get("pageToken")).toBe("repeat");
      return jsonResponse({ timeSeries: [], nextPageToken: "repeat" });
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("partial");
    expect(result.requests).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
    expect(result.totalRequests).toBeNull();
    expect(result.externalBillingSyncs.map((sync) => sync.source)).toEqual([
      "google-cloud-monitoring-quota-usage",
      "google-cloud-monitoring-quota-limits",
    ]);
  });
});
