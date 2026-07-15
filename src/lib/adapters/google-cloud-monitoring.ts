import { createHash } from "node:crypto";
import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
} from "./helpers";
import {
  fetchGoogleServiceAccountAccessToken,
  GOOGLE_MONITORING_READ_SCOPE,
  parseGoogleServiceAccountCredential,
} from "./google-service-account";

const MONITORING_API = "https://monitoring.googleapis.com/v3";
const GEMINI_SERVICE = "generativelanguage.googleapis.com";
const REQUEST_COUNT_METRIC =
  "serviceruntime.googleapis.com/api/request_count";
const QUOTA_USAGE_METRIC =
  "serviceruntime.googleapis.com/quota/rate/net_usage";
const QUOTA_LIMIT_METRIC = "serviceruntime.googleapis.com/quota/limit";
const MAX_PAGES = 5;
const PAGE_SIZE = 1_000;
const MAX_POINTS = MAX_PAGES * PAGE_SIZE;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETAINED_QUOTAS = 100;

type QueryName = "requests" | "quotaUsage" | "quotaLimits";
type MonitoringStatus =
  | "ready"
  | "empty"
  | "partial"
  | "permission_denied"
  | "error";

interface MonitoringPoint {
  value: number;
  endTime: string;
}

interface MonitoringSeries {
  metricLabels: Record<string, string>;
  resourceLabels: Record<string, string>;
  points: MonitoringPoint[];
}

interface QuerySuccess {
  name: QueryName;
  status: "ready" | "empty";
  series: MonitoringSeries[];
}

interface QueryFailure {
  name: QueryName;
  status: "error";
  error: AdapterError;
}

type QueryOutcome = QuerySuccess | QueryFailure;

export interface GoogleMonitoringQuotaItem {
  quotaMetric: string;
  limitName: string | null;
  location: string;
  unit: "requests" | "tokens";
  value: number;
  reportThrough: string;
}

export interface GoogleCloudMonitoringResult {
  status: MonitoringStatus;
  projectId: string;
  windowStart: string;
  windowEnd: string;
  totalRequests: number | null;
  reportThrough: string | null;
  requests: {
    status: "ready" | "empty" | "error";
    total: number | null;
    seriesCount: number;
    pointCount: number;
    errorCode?: string;
    httpStatus?: number | null;
    retryable?: boolean;
  };
  quotaUsage: {
    status: "ready" | "empty" | "error";
    availableCount: number;
    retainedCount: number;
    truncated: boolean;
    items: GoogleMonitoringQuotaItem[];
    errorCode?: string;
    httpStatus?: number | null;
    retryable?: boolean;
  };
  quotaLimits: {
    status: "ready" | "empty" | "error";
    availableCount: number;
    retainedCount: number;
    truncated: boolean;
    items: GoogleMonitoringQuotaItem[];
    errorCode?: string;
    httpStatus?: number | null;
    retryable?: boolean;
  };
  externalBillingSyncs: AdapterExternalBillingSync[];
  partialError?: AdapterError;
}

interface TimeSeriesResponse {
  timeSeries?: unknown;
  nextPageToken?: unknown;
}

interface QuerySpec {
  name: QueryName;
  metricType: string;
  resourceType: "consumed_api" | "consumer_quota";
  window: { start: string; end: string };
  alignment?: {
    period: string;
    aligner: "ALIGN_SUM";
    reducer?: "REDUCE_SUM";
    groupByFields?: string[];
  };
}

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanProjectId(value: unknown): string {
  const projectId = cleanString(value);
  if (!projectId || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    configurationError(
      "Google Cloud Monitoring requires an exact googleProjectId"
    );
  }
  return projectId;
}

function cleanLabels(value: unknown, field: string): Record<string, string> {
  if (value == null) return {};
  const record = asRecord(value);
  if (!record) invalidResponse(`Google Cloud Monitoring ${field} are malformed`);
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) {
      invalidResponse(`Google Cloud Monitoring ${field} contain an invalid key`);
    }
    const text = cleanString(raw);
    if (text == null || text.length > 512) {
      invalidResponse(`Google Cloud Monitoring ${field} contain an invalid value`);
    }
    labels[key] = text;
  }
  return labels;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = cleanString(value);
  const milliseconds = text == null ? Number.NaN : Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    invalidResponse(`Google Cloud Monitoring ${field} is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function numericPoint(value: unknown): number {
  const record = asRecord(value);
  if (!record) invalidResponse("Google Cloud Monitoring point value is malformed");
  const candidates = [record.int64Value, record.doubleValue]
    .filter((candidate) => candidate != null)
    .map(parseNumber);
  if (candidates.length !== 1 || candidates[0] == null) {
    invalidResponse("Google Cloud Monitoring point value is not numeric");
  }
  const number = candidates[0];
  if (!Number.isFinite(number) || number < 0) {
    invalidResponse("Google Cloud Monitoring point value is invalid");
  }
  return number;
}

function parseSeries(
  value: unknown,
  spec: QuerySpec,
  projectId: string
): MonitoringSeries {
  const record = asRecord(value);
  const metric = asRecord(record?.metric);
  const resource = asRecord(record?.resource);
  if (
    !record ||
    cleanString(metric?.type) !== spec.metricType ||
    cleanString(resource?.type) !== spec.resourceType ||
    !Array.isArray(record.points)
  ) {
    invalidResponse("Google Cloud Monitoring time series is malformed");
  }
  const metricLabels = cleanLabels(metric?.labels, "metric labels");
  const resourceLabels = cleanLabels(resource?.labels, "resource labels");
  if (
    resourceLabels.service !== GEMINI_SERVICE ||
    (resourceLabels.project_id != null &&
      resourceLabels.project_id !== projectId)
  ) {
    invalidResponse("Google Cloud Monitoring returned an out-of-scope series");
  }
  const points = record.points.map((rawPoint) => {
    const point = asRecord(rawPoint);
    const interval = asRecord(point?.interval);
    if (!point || !interval) {
      invalidResponse("Google Cloud Monitoring point is malformed");
    }
    return {
      value: numericPoint(point.value),
      endTime: isoTimestamp(interval.endTime, "point endTime"),
    };
  });
  return { metricLabels, resourceLabels, points };
}

function monitoringFilter(spec: QuerySpec): string {
  return [
    `metric.type = "${spec.metricType}"`,
    `resource.type = "${spec.resourceType}"`,
    `resource.labels.service = "${GEMINI_SERVICE}"`,
  ].join(" AND ");
}

async function fetchTimeSeries(
  projectId: string,
  token: string,
  spec: QuerySpec
): Promise<MonitoringSeries[]> {
  const series: MonitoringSeries[] = [];
  const seenTokens = new Set<string>();
  let pointCount = 0;
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(
      `${MONITORING_API}/projects/${encodeURIComponent(projectId)}/timeSeries`
    );
    url.searchParams.set("filter", monitoringFilter(spec));
    url.searchParams.set("interval.startTime", spec.window.start);
    url.searchParams.set("interval.endTime", spec.window.end);
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (spec.alignment) {
      url.searchParams.set(
        "aggregation.alignmentPeriod",
        spec.alignment.period
      );
      url.searchParams.set(
        "aggregation.perSeriesAligner",
        spec.alignment.aligner
      );
      if (spec.alignment.reducer) {
        url.searchParams.set(
          "aggregation.crossSeriesReducer",
          spec.alignment.reducer
        );
      }
      for (const field of spec.alignment.groupByFields ?? []) {
        url.searchParams.append("aggregation.groupByFields", field);
      }
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetchJson(
      url.toString(),
      { headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES }
    );
    if (!response.ok) {
      errorResult(response.status, {
        note: `Google Cloud Monitoring ${spec.name} query failed`,
      });
    }
    const data = asRecord(response.data) as TimeSeriesResponse | null;
    if (!data) invalidResponse("Google Cloud Monitoring response is malformed");
    if (data.timeSeries != null && !Array.isArray(data.timeSeries)) {
      invalidResponse("Google Cloud Monitoring timeSeries is malformed");
    }
    for (const rawSeries of (data.timeSeries as unknown[] | undefined) ?? []) {
      const parsed = parseSeries(rawSeries, spec, projectId);
      pointCount += parsed.points.length;
      if (pointCount > MAX_POINTS) {
        invalidResponse("Google Cloud Monitoring query exceeded the point limit");
      }
      series.push(parsed);
    }

    const nextToken = cleanString(data.nextPageToken);
    if (!nextToken) return series;
    if (seenTokens.has(nextToken)) {
      invalidResponse("Google Cloud Monitoring repeated a page token");
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  invalidResponse("Google Cloud Monitoring query exceeded the page limit");
}

function monthWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString(), end: now.toISOString() };
}

function latestTimestamp(series: MonitoringSeries[]): string | null {
  return series
    .flatMap((item) => item.points.map((point) => point.endTime))
    .sort()
    .at(-1) ?? null;
}

function safeSum(values: number[], label: string): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    invalidResponse(`Google Cloud Monitoring ${label} total is invalid`);
  }
  return total;
}

function quotaUnit(value: string): "requests" | "tokens" | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("token")) return "tokens";
  if (normalized.includes("request")) return "requests";
  return null;
}

function displayQuotaName(value: string): string {
  const tail = value.split("/").filter(Boolean).at(-1) ?? value;
  return tail
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function stableExternalId(prefix: string, values: string[]): string {
  const digest = createHash("sha256")
    .update("api-usage-monitor:google-monitoring:v1\0", "utf8")
    .update(JSON.stringify(values), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function aggregateQuotaUsage(series: MonitoringSeries[]): GoogleMonitoringQuotaItem[] {
  const grouped = new Map<string, GoogleMonitoringQuotaItem>();
  for (const item of series) {
    const quotaMetric = cleanString(item.metricLabels.quota_metric);
    if (!quotaMetric) continue;
    const unit = quotaUnit(quotaMetric);
    if (!unit) continue;
    const value = safeSum(
      item.points.map((point) => point.value),
      "quota usage"
    );
    const reportThrough = latestTimestamp([item]);
    if (value == null || reportThrough == null) continue;
    const location = item.resourceLabels.location || "global";
    const key = JSON.stringify([quotaMetric, location, unit]);
    const existing = grouped.get(key);
    if (existing) {
      const combined = existing.value + value;
      if (!Number.isSafeInteger(combined)) {
        invalidResponse("Google Cloud Monitoring quota usage total is invalid");
      }
      existing.value = combined;
      if (reportThrough > existing.reportThrough) {
        existing.reportThrough = reportThrough;
      }
    } else {
      grouped.set(key, {
        quotaMetric,
        limitName: null,
        location,
        unit,
        value,
        reportThrough,
      });
    }
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.quotaMetric.localeCompare(right.quotaMetric) ||
      left.location.localeCompare(right.location)
  );
}

function aggregateQuotaLimits(series: MonitoringSeries[]): GoogleMonitoringQuotaItem[] {
  const grouped = new Map<string, GoogleMonitoringQuotaItem>();
  for (const item of series) {
    const quotaMetric = cleanString(item.metricLabels.quota_metric);
    const limitName = cleanString(item.metricLabels.limit_name);
    if (!quotaMetric || !limitName) continue;
    const unit = quotaUnit(`${quotaMetric} ${limitName}`);
    if (!unit || item.points.length === 0) continue;
    const latest = [...item.points].sort((left, right) =>
      right.endTime.localeCompare(left.endTime)
    )[0];
    if (!Number.isSafeInteger(latest.value)) {
      invalidResponse("Google Cloud Monitoring quota limit is invalid");
    }
    const location = item.resourceLabels.location || "global";
    const key = JSON.stringify([quotaMetric, limitName, location, unit]);
    const existing = grouped.get(key);
    if (!existing || latest.endTime > existing.reportThrough) {
      grouped.set(key, {
        quotaMetric,
        limitName,
        location,
        unit,
        value: latest.value,
        reportThrough: latest.endTime,
      });
    } else if (
      latest.endTime === existing.reportThrough &&
      latest.value > existing.value
    ) {
      // Duplicate dimensions can remain after Google omits a non-grouped
      // label. Preserve the effective maximum instead of summing limits.
      existing.value = latest.value;
    }
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.quotaMetric.localeCompare(right.quotaMetric) ||
      (left.limitName ?? "").localeCompare(right.limitName ?? "") ||
      left.location.localeCompare(right.location)
  );
}

function requestRecord(
  totalRequests: number,
  window: { start: string; end: string },
  reportThrough: string
): AdapterExternalBillingRecord {
  return {
    externalId: "gemini-requests-mtd",
    kind: "account",
    serviceName: "Gemini API requests",
    planName: "Cloud Monitoring month to date",
    status: "active",
    currentPeriodStart: window.start,
    currentPeriodEnd: reportThrough,
    usageQuantity: totalRequests,
    usageUnit: "requests",
    rollupRole: "metadata",
    dateKind: "report_through",
  };
}

function quotaUsageRecord(
  item: GoogleMonitoringQuotaItem,
  windowStart: string
): AdapterExternalBillingRecord {
  return {
    externalId: stableExternalId("quota-usage", [
      item.quotaMetric,
      item.location,
      item.unit,
    ]),
    kind: "account",
    serviceName: `Gemini ${displayQuotaName(item.quotaMetric)}`,
    planName: "Cloud Monitoring month-to-date quota usage",
    status: "active",
    currentPeriodStart: windowStart,
    currentPeriodEnd: item.reportThrough,
    usageQuantity: item.value,
    usageUnit: item.unit,
    rollupRole: "metadata",
    dateKind: "report_through",
  };
}

function quotaLimitRecord(
  item: GoogleMonitoringQuotaItem
): AdapterExternalBillingRecord {
  const label = item.limitName ?? item.quotaMetric;
  return {
    externalId: stableExternalId("quota-limit", [
      item.quotaMetric,
      label,
      item.location,
      item.unit,
    ]),
    kind: "account",
    serviceName: `Gemini ${displayQuotaName(label)}`,
    planName: "Cloud Monitoring quota limit",
    status: "active",
    currentPeriodEnd: item.reportThrough,
    requestLimit: item.value,
    requestLimitWindow: displayQuotaName(label),
    usageUnit: item.unit,
    rollupRole: "metadata",
    dateKind: "report_through",
  };
}

async function queryOutcome(
  projectId: string,
  token: string,
  spec: QuerySpec
): Promise<QueryOutcome> {
  try {
    const series = await fetchTimeSeries(projectId, token, spec);
    return {
      name: spec.name,
      status: series.some((item) => item.points.length > 0) ? "ready" : "empty",
      series,
    };
  } catch (error) {
    return {
      name: spec.name,
      status: "error",
      error:
        error instanceof AdapterError
          ? error
          : new AdapterError(
              `Google Cloud Monitoring ${spec.name} query failed`,
              {
                code: "TRANSPORT_ERROR",
                retryable: true,
                cause: error,
              }
            ),
    };
  }
}

function querySummary(outcome: QueryOutcome) {
  if (outcome.status !== "error") {
    return { status: outcome.status } as const;
  }
  return {
    status: "error" as const,
    errorCode: outcome.error.code,
    httpStatus: outcome.error.status,
    retryable: outcome.error.retryable,
  };
}

function combinedQueryError(failures: QueryFailure[]): AdapterError | undefined {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0].error;
  return new AdapterError(
    `Google Cloud Monitoring partial sync failed: ${failures
      .map(({ name, error }) => `${name}: ${error.message}`)
      .join("; ")}`,
    {
      code: failures[0].error.code,
      status: failures.every(
        ({ error }) => error.status === failures[0].error.status
      )
        ? failures[0].error.status
        : null,
      retryable: failures.some(({ error }) => error.retryable),
    }
  );
}

export async function fetchGoogleCloudMonitoring(
  config: Record<string, unknown>
): Promise<GoogleCloudMonitoringResult> {
  const projectId = cleanProjectId(config.googleProjectId);
  const credential = parseGoogleServiceAccountCredential(
    config.serviceAccountJson
  );
  const token = await fetchGoogleServiceAccountAccessToken(
    credential,
    GOOGLE_MONITORING_READ_SCOPE
  );
  const window = monthWindow();
  const specs: QuerySpec[] = [
    {
      name: "requests",
      metricType: REQUEST_COUNT_METRIC,
      resourceType: "consumed_api",
      window,
      alignment: {
        period: "86400s",
        aligner: "ALIGN_SUM",
        reducer: "REDUCE_SUM",
        groupByFields: ["resource.labels.service"],
      },
    },
    {
      name: "quotaUsage",
      metricType: QUOTA_USAGE_METRIC,
      resourceType: "consumer_quota",
      window,
      alignment: { period: "86400s", aligner: "ALIGN_SUM" },
    },
    {
      name: "quotaLimits",
      metricType: QUOTA_LIMIT_METRIC,
      resourceType: "consumer_quota",
      window,
    },
  ];
  const outcomes = await Promise.all(
    specs.map((spec) => queryOutcome(projectId, token, spec))
  );
  const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]));
  const requests = byName.get("requests")!;
  const usage = byName.get("quotaUsage")!;
  const limits = byName.get("quotaLimits")!;
  const requestTotal =
    requests.status === "error"
      ? null
      : safeSum(
          requests.series.flatMap((series) =>
            series.points.map((point) => point.value)
          ),
          "request"
        );
  const requestReportThrough =
    requests.status === "error" ? null : latestTimestamp(requests.series);
  const usageItems =
    usage.status === "error" ? [] : aggregateQuotaUsage(usage.series);
  const limitItems =
    limits.status === "error" ? [] : aggregateQuotaLimits(limits.series);
  const retainedUsage = usageItems.slice(0, MAX_RETAINED_QUOTAS);
  const retainedLimits = limitItems.slice(0, MAX_RETAINED_QUOTAS);
  const usageTruncated = retainedUsage.length !== usageItems.length;
  const limitsTruncated = retainedLimits.length !== limitItems.length;
  const failures = outcomes.filter(
    (outcome): outcome is QueryFailure => outcome.status === "error"
  );
  const successes = outcomes.length - failures.length;
  const anyData = outcomes.some(
    (outcome) => outcome.status === "ready"
  );
  const permissionDenied =
    failures.length === outcomes.length &&
    failures.every(({ error }) =>
      error.status === 401 || error.status === 403
    );
  const status: MonitoringStatus =
    failures.length > 0
      ? successes > 0
        ? "partial"
        : permissionDenied
          ? "permission_denied"
          : "error"
      : usageTruncated || limitsTruncated
        ? "partial"
        : anyData
          ? "ready"
          : "empty";

  const externalBillingSyncs: AdapterExternalBillingSync[] = [];
  if (requests.status !== "error") {
    externalBillingSyncs.push({
      source: "google-cloud-monitoring-requests",
      authoritative: true,
      records:
        requestTotal != null && requestReportThrough != null
          ? [requestRecord(requestTotal, window, requestReportThrough)]
          : [],
    });
  }
  if (usage.status !== "error") {
    externalBillingSyncs.push({
      source: "google-cloud-monitoring-quota-usage",
      authoritative: !usageTruncated,
      records: retainedUsage.map((item) =>
        quotaUsageRecord(item, window.start)
      ),
    });
  }
  if (limits.status !== "error") {
    externalBillingSyncs.push({
      source: "google-cloud-monitoring-quota-limits",
      authoritative: !limitsTruncated,
      records: retainedLimits.map(quotaLimitRecord),
    });
  }

  return {
    status,
    projectId,
    windowStart: window.start,
    windowEnd: window.end,
    totalRequests: requestTotal,
    reportThrough: [
      requestReportThrough,
      ...retainedUsage.map((item) => item.reportThrough),
      ...retainedLimits.map((item) => item.reportThrough),
    ]
      .filter((value): value is string => value != null)
      .sort()
      .at(-1) ?? null,
    requests: {
      ...querySummary(requests),
      total: requestTotal,
      seriesCount: requests.status === "error" ? 0 : requests.series.length,
      pointCount:
        requests.status === "error"
          ? 0
          : requests.series.reduce(
              (sum, series) => sum + series.points.length,
              0
            ),
    },
    quotaUsage: {
      ...querySummary(usage),
      availableCount: usageItems.length,
      retainedCount: retainedUsage.length,
      truncated: usageTruncated,
      items: retainedUsage,
    },
    quotaLimits: {
      ...querySummary(limits),
      availableCount: limitItems.length,
      retainedCount: retainedLimits.length,
      truncated: limitsTruncated,
      items: retainedLimits,
    },
    externalBillingSyncs,
    partialError: combinedQueryError(failures),
  };
}
