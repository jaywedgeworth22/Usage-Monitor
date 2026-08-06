import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

/**
 * Cloudflare R2 free-tier monitor + automatic shutoff.
 *
 * Free tier (account-wide, resets monthly):
 *   - Storage: 10 GB-month
 *   - Class A ops: 1,000,000 / month
 *   - Class B ops: 10,000,000 / month
 *
 * Hard policy at {@link R2_THRESHOLD_PCT} (70%):
 *   - **Storage (stock):** absolute MTD ≥ 70% of free tier → stop.
 *     No pace projection for storage (a steady 6 GiB all month is fine;
 *     7 GiB is not).
 *   - **Class A / Class B (flows):** absolute MTD ≥ 70% **or** linear
 *     month-end pace projects ≥ 70% → stop.
 *
 * On trip we:
 *   1. Persist `/data/r2-disabled-70pct.flag` (and set env)
 *   2. Alert via Pushover (`PUSHOVER_USAGE_API_TOKEN`, then generic fallbacks)
 *   3. Stop R2-backed Litestream (startup gate + runtime watcher)
 *
 * Production fail-closed: if Litestream points at R2 and analytics credentials
 * are missing (or GraphQL fetch fails) while `LITESTREAM_REQUIRED=true` or
 * `NODE_ENV=production`, we **disable R2 writes** rather than fly blind.
 * Local SQLite size and day-of-month stubs are never used as R2 metrics.
 *
 * Required credentials (either pair):
 *   - `R2_USAGE_ACCOUNT_ID` + `R2_USAGE_API_TOKEN`, or
 *   - `CLOUDFLARE_JAY_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID` +
 *     `CLOUDFLARE_JAY_API_TOKEN` / `CLOUDFLARE_API_TOKEN`
 */

export interface R2UsageLimits {
  storageBytes: number; // 10 GiB = 10 * 1024 * 1024 * 1024
  classAOps: number; // 1,000,000
  classBOps: number; // 10,000,000
}

export const DEFAULT_R2_FREE_TIER_LIMITS: R2UsageLimits = {
  storageBytes: 10 * 1024 * 1024 * 1024,
  classAOps: 1_000_000,
  classBOps: 10_000_000,
};

export const R2_THRESHOLD_PCT = 70;

export const R2_DISABLED_FLAG_FILENAME = "r2-disabled-70pct.flag";
export const R2_EMERGENCY_ALERT_FLAG_FILENAME = "r2-emergency-alert-sent.flag";
export const R2_DAILY_PUSHOVER_FILENAME = "r2-last-daily-pushover.json";

/** Official Class A action types (writes / lists). Unknown actions count as A. */
export const R2_CLASS_A_ACTIONS = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "ListObjectsV2",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
  "DeleteObject",
  "DeleteObjects",
  "DeleteBucket",
  "AbortMultipartUpload",
  "PutBucketOwnershipControls",
  "PutBucketPolicy",
  "PutBucketLogging",
  "PutBucketVersioning",
  "PutBucketNotification",
  "PutBucketReplication",
  "PutBucketTagging",
  "PutBucketWebsite",
  "PutObjectLockConfiguration",
  "PutObjectRetention",
  "PutObjectLegalHold",
  "PutObjectTagging",
]);

/** Official Class B action types (reads / HEAD). */
export const R2_CLASS_B_ACTIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
  "GetBucketOwnershipControls",
  "GetBucketPolicy",
  "GetBucketLogging",
  "GetBucketVersioning",
  "GetBucketNotification",
  "GetBucketNotificationConfiguration",
  "GetBucketReplication",
  "GetBucketTagging",
  "GetBucketWebsite",
  "GetObjectLockConfiguration",
  "GetObjectRetention",
  "GetObjectLegalHold",
  "GetObjectTagging",
  "GetBucketSippyConfiguration",
]);

export interface R2MetricStatus {
  actual: number;
  limit: number;
  mtdPct: number;
  projected: number;
  projectedPct: number;
  onTrackToExceed: boolean;
}

export type R2MetricsSource =
  | "live_s3_storage+graphql_ops"
  | "cloudflare_graphql"
  | "unavailable";

/** Max age of GraphQL storage samples before we refuse to kill on them (stale). */
export const R2_GRAPHQL_STORAGE_MAX_AGE_MS = 90 * 60 * 1000;

/** Auto-resume hysteresis: clear kill switch when live storage is below this. */
export const R2_RESUME_STORAGE_PCT = 65;

/**
 * Soft tip-prune threshold: when live storage reaches this absolute share of the
 * free tier, delete non-tip LTX per level (latest max-txid kept) before the 70%
 * kill. Disaster recovery only needs the tip chain; multi-level LTX history is
 * what re-breaches free tier every day (2026-08-04 / 2026-08-06).
 */
export const R2_SOFT_PRUNE_STORAGE_PCT = 50;

/** Litestream LTX object key: .../prod.db/0001/00000000-00000001.ltx */
export const LTX_OBJECT_KEY_RE =
  /^(?<prefix>.+\/)(?<level>\d{4})\/(?<min>[0-9a-fA-F]+)-(?<max>[0-9a-fA-F]+)\.ltx$/;

export interface R2BucketStorageSample {
  bucketName: string;
  bytes: number;
  objectCount: number;
  asOf: string | null;
}

export interface R2UsageAssessment {
  timestamp: string;
  storage: R2MetricStatus;
  classA: R2MetricStatus;
  classB: R2MetricStatus;
  overallOnTrackToExceed70Pct: boolean;
  exceededMetric?: "storage" | "classA" | "classB";
  metricsSource: R2MetricsSource;
  metricsError?: string;
  buckets?: R2BucketStorageSample[];
  litestreamUsesR2?: boolean;
  autoDisabled?: boolean;
  /** True when storage bytes came from live S3 ListObjects (not GraphQL lag). */
  storageIsLive?: boolean;
  /** True when GraphQL storage samples were too old to trust for kill decisions. */
  storageSampleStale?: boolean;
}

export interface R2UsageCredentials {
  accountId: string;
  apiToken: string;
}

export interface FetchedR2UsageMetrics {
  storageBytes: number;
  classAOps: number;
  classBOps: number;
  buckets: R2BucketStorageSample[];
  rawActionCounts: Record<string, number>;
}

let inMemoryLastDailyPushoverDate = "";
let inMemoryEmergencyAlertSent = false;
let cachedFallbackFlagDir: string | null = null;
/** Live ListObjects inventory cache (declared early for test reset). */
let liveS3ListCache: {
  atMs: number;
  value: { storageBytes: number; buckets: R2BucketStorageSample[] };
} | null = null;

function getFlagDir(): string {
  if (fs.existsSync("/data")) return "/data";
  // Fallback for environments without the persistent /data volume: use a
  // private per-process directory (mkdtemp creates it 0o700 with an
  // unpredictable suffix) instead of predictable paths directly inside the
  // shared world-writable os temp dir, which are vulnerable to symlink /
  // pre-creation attacks (CodeQL js/insecure-temporary-file).
  if (!cachedFallbackFlagDir) {
    cachedFallbackFlagDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-r2-"));
  }
  return cachedFallbackFlagDir;
}

function getFlagFilePath(filename: string): string {
  return path.join(getFlagDir(), filename);
}

/** Test-only: resolve where a flag file would be written. */
export function __getR2FlagFilePathForTests(filename: string): string {
  return getFlagFilePath(filename);
}

/** Test-only: clear in-memory memos and the private fallback flag directory. */
export function __resetR2UsageStateForTests(): void {
  inMemoryLastDailyPushoverDate = "";
  inMemoryEmergencyAlertSent = false;
  liveS3ListCache = null;
  if (cachedFallbackFlagDir) {
    try {
      fs.rmSync(cachedFallbackFlagDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    cachedFallbackFlagDir = null;
  }
}

/**
 * True when the configured Litestream S3 endpoint is Cloudflare R2.
 * Garage / MinIO / other S3 endpoints return false so free-tier kill never
 * takes down non-R2 backup paths.
 *
 * Hostname is parsed with the URL API (not a substring match) so an attacker
 * cannot spoof "not R2" / "is R2" via path/query/userinfo tricks
 * (CodeQL js/incomplete-url-substring-sanitization).
 */
export function isLitestreamR2Endpoint(
  endpoint: string | undefined | null = process.env.LITESTREAM_S3_ENDPOINT ??
    process.env.AWS_S3_ENDPOINT
): boolean {
  if (!endpoint || typeof endpoint !== "string") return false;
  const trimmed = endpoint.trim();
  if (!trimmed) return false;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return (
      host === "r2.cloudflarestorage.com" ||
      host.endsWith(".r2.cloudflarestorage.com") ||
      host === "r2.cloudflare.com" ||
      host.endsWith(".r2.cloudflare.com")
    );
  } catch {
    return false;
  }
}

export function resolveR2UsageCredentials(
  env: Record<string, string | undefined> = process.env
): R2UsageCredentials | null {
  const accountId = (
    env.R2_USAGE_ACCOUNT_ID ||
    env.CLOUDFLARE_JAY_ACCOUNT_ID ||
    env.CLOUDFLARE_ACCOUNT_ID ||
    ""
  ).trim();
  const apiToken = (
    env.R2_USAGE_API_TOKEN ||
    env.CLOUDFLARE_JAY_API_TOKEN ||
    env.CLOUDFLARE_API_TOKEN ||
    ""
  ).trim();
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

export function classifyR2Action(actionType: string): "A" | "B" {
  if (R2_CLASS_B_ACTIONS.has(actionType)) return "B";
  // Conservative default: treat unknowns (and explicit Class A) as Class A so
  // free-tier shutoff trips early rather than late.
  return "A";
}

export type R2ThresholdMode =
  /** Absolute MTD share only (storage stock). */
  | "absolute"
  /** Absolute MTD share OR linear month-end pace (ops flows). */
  | "absolute_or_pace";

export function calculatePaceProjection(
  actual: number,
  limit: number,
  now: Date = new Date(),
  thresholdPct: number = R2_THRESHOLD_PCT,
  mode: R2ThresholdMode = "absolute_or_pace"
): R2MetricStatus {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

  const totalMs = endOfMonth.getTime() - startOfMonth.getTime();
  const elapsedMs = now.getTime() - startOfMonth.getTime();
  const elapsedFraction = Math.max(elapsedMs / totalMs, 0.02);

  const mtdPct = (actual / limit) * 100;
  const projected = actual / elapsedFraction;
  const projectedPct = (projected / limit) * 100;
  const absoluteBreach = mtdPct >= thresholdPct;
  const paceBreach = projectedPct >= thresholdPct;
  const onTrackToExceed =
    mode === "absolute" ? absoluteBreach : absoluteBreach || paceBreach;

  return {
    actual,
    limit,
    mtdPct: Number(mtdPct.toFixed(2)),
    projected: Number(projected.toFixed(2)),
    projectedPct: Number(projectedPct.toFixed(2)),
    onTrackToExceed,
  };
}

/**
 * True when production must not run R2-backed Litestream without a working
 * free-tier meter (would otherwise burn the account blind).
 */
export function r2FreeTierFailClosedRequired(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!isLitestreamR2Endpoint(env.LITESTREAM_S3_ENDPOINT ?? env.AWS_S3_ENDPOINT)) {
    return false;
  }
  return env.LITESTREAM_REQUIRED === "true" || env.NODE_ENV === "production";
}

export function assessR2Usage(
  actualStorageBytes: number,
  actualClassAOps: number,
  actualClassBOps: number,
  limits: R2UsageLimits = DEFAULT_R2_FREE_TIER_LIMITS,
  now: Date = new Date(),
  extras: {
    metricsSource?: R2MetricsSource;
    metricsError?: string;
    buckets?: R2BucketStorageSample[];
  } = {}
): R2UsageAssessment {
  // Storage: absolute 70% of free tier only (stock). Ops: absolute or pace.
  const storage = calculatePaceProjection(
    actualStorageBytes,
    limits.storageBytes,
    now,
    R2_THRESHOLD_PCT,
    "absolute"
  );
  const classA = calculatePaceProjection(
    actualClassAOps,
    limits.classAOps,
    now,
    R2_THRESHOLD_PCT,
    "absolute_or_pace"
  );
  const classB = calculatePaceProjection(
    actualClassBOps,
    limits.classBOps,
    now,
    R2_THRESHOLD_PCT,
    "absolute_or_pace"
  );

  const overallOnTrackToExceed70Pct =
    storage.onTrackToExceed || classA.onTrackToExceed || classB.onTrackToExceed;

  let exceededMetric: "storage" | "classA" | "classB" | undefined;
  if (storage.onTrackToExceed) exceededMetric = "storage";
  else if (classA.onTrackToExceed) exceededMetric = "classA";
  else if (classB.onTrackToExceed) exceededMetric = "classB";

  return {
    timestamp: now.toISOString(),
    storage,
    classA,
    classB,
    overallOnTrackToExceed70Pct,
    exceededMetric,
    metricsSource: extras.metricsSource ?? "cloudflare_graphql",
    metricsError: extras.metricsError,
    buckets: extras.buckets,
    litestreamUsesR2: isLitestreamR2Endpoint(),
  };
}

export function isR2AutoDisabled(): boolean {
  if (process.env.LITESTREAM_EMERGENCY_DISABLE === "true") return true;
  if (process.env.R2_WRITES_DISABLED === "true") return true;
  try {
    return fs.existsSync(getFlagFilePath(R2_DISABLED_FLAG_FILENAME));
  } catch {
    return false;
  }
}

/**
 * Persist the free-tier kill switch. Sets env so in-process readers see it
 * immediately; writes the flag so start-with-litestream.sh and a runtime
 * watcher stop R2-backed Litestream without needing a redeploy.
 */
/** Clear free-tier kill switch so litestream can resume after prune/restart. */
export function clearR2AutoDisable(): void {
  delete process.env.LITESTREAM_EMERGENCY_DISABLE;
  delete process.env.R2_WRITES_DISABLED;
  process.env.LITESTREAM_EMERGENCY_DISABLE = "false";
  process.env.R2_WRITES_DISABLED = "false";
  try {
    const flag = getFlagFilePath(R2_DISABLED_FLAG_FILENAME);
    if (fs.existsSync(flag)) fs.unlinkSync(flag);
  } catch (err) {
    console.error("[r2-usage] Failed clearing emergency disable flag:", err);
  }
  try {
    const alert = getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME);
    if (fs.existsSync(alert)) fs.unlinkSync(alert);
  } catch {
    // best-effort
  }
  inMemoryEmergencyAlertSent = false;
}

export function enforceR2AutoDisable(reason: string): void {
  process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
  process.env.R2_WRITES_DISABLED = "true";
  // Also clear the "active" claim so readiness/runtime-health immediately
  // report backup as stopped (start-with-litestream only sets this at boot).
  process.env.LITESTREAM_ACTIVE = "false";
  try {
    const filePath = getFlagFilePath(R2_DISABLED_FLAG_FILENAME);
    fs.writeFileSync(
      filePath,
      `Disabled at ${new Date().toISOString()}: ${reason}\n` +
        `Resume: delete this file and clear LITESTREAM_EMERGENCY_DISABLE / R2_WRITES_DISABLED, then restart the container.\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error("[r2-usage] Failed writing emergency disable flag file:", err);
  }
  console.error(
    `[r2-usage] R2 free-tier auto-disable engaged: ${reason}` +
      (isLitestreamR2Endpoint()
        ? " (Litestream endpoint is R2 — replication will stop)"
        : " (Litestream endpoint is not R2 — non-R2 replica left running; unexpected in production)")
  );
}



export async function sendPushoverNotification(
  title: string,
  message: string,
  priority: number = 0,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const userKey = process.env.PUSHOVER_USER_KEY;
  // Prefer the Usage Monitor-owned app token so R2 free-tier alerts are
  // attributed to this product, not Socratic/Congress tokens that may also
  // exist on a shared host env.
  const apiToken =
    process.env.PUSHOVER_USAGE_API_TOKEN ||
    process.env.PUSHOVER_API_TOKEN ||
    process.env.PUSHOVER_APP_TOKEN ||
    process.env.PUSHOVER_ST_API_TOKEN ||
    process.env.PUSHOVER_CT_API_TOKEN;

  if (!userKey || !apiToken) {
    return {
      ok: false,
      error:
        "Pushover credentials not configured (need PUSHOVER_USER_KEY + PUSHOVER_USAGE_API_TOKEN or PUSHOVER_API_TOKEN)",
    };
  }

  const form = new URLSearchParams({
    token: apiToken,
    user: userKey,
    title,
    message,
    priority: String(priority),
  });

  try {
    const res = await fetchImpl("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getLastDailyPushoverDate(): string {
  if (inMemoryLastDailyPushoverDate) return inMemoryLastDailyPushoverDate;
  try {
    const filePath = getFlagFilePath(R2_DAILY_PUSHOVER_FILENAME);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof data?.date === "string") {
        inMemoryLastDailyPushoverDate = data.date;
        return data.date;
      }
    }
  } catch {
    // fall through
  }
  return "";
}

export function recordDailyPushoverSent(dateStr: string): void {
  inMemoryLastDailyPushoverDate = dateStr;
  try {
    const filePath = getFlagFilePath(R2_DAILY_PUSHOVER_FILENAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ date: dateStr, sentAt: new Date().toISOString() }),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error("[r2-usage] Failed saving last daily pushover file:", err);
  }
}

export function formatDailyPushoverMessage(
  assessment: R2UsageAssessment,
  disabled: boolean
): { title: string; body: string } {
  const storageGIB = (assessment.storage.actual / (1024 * 1024 * 1024)).toFixed(
    2
  );
  const title = "📊 Cloudflare R2 Free Tier Status";

  const statusStr = disabled
    ? "🛑 DISABLED (Auto-killed at 70% threshold)"
    : assessment.metricsSource === "unavailable"
      ? "❓ METRICS UNAVAILABLE (no auto-disable)"
      : assessment.overallOnTrackToExceed70Pct
        ? "⚠️ WARNING (Pace/MTD >= 70%)"
        : "✅ OK (Under 70% free-tier pace)";

  const topBuckets = (assessment.buckets ?? [])
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map(
      (b) =>
        `  ${b.bucketName}: ${(b.bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
    );

  const body = [
    `R2 Storage: ${storageGIB} GiB / 10.00 GiB (${assessment.storage.mtdPct}% MTD, ${assessment.storage.projectedPct}% proj)`,
    `Class A Ops: ${assessment.classA.actual.toLocaleString()} / 1,000,000 (${assessment.classA.mtdPct}% MTD, ${assessment.classA.projectedPct}% proj)`,
    `Class B Ops: ${assessment.classB.actual.toLocaleString()} / 10,000,000 (${assessment.classB.mtdPct}% MTD, ${assessment.classB.projectedPct}% proj)`,
    `Threshold: ${R2_THRESHOLD_PCT}% max pace/MTD`,
    `Source: ${assessment.metricsSource}`,
    `Litestream→R2: ${assessment.litestreamUsesR2 ? "yes" : "no"}`,
    topBuckets.length ? `Top buckets:\n${topBuckets.join("\n")}` : null,
    `Status: ${statusStr}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { title, body };
}

export function isR2EmergencyAlertSent(): boolean {
  if (inMemoryEmergencyAlertSent) return true;
  try {
    return fs.existsSync(getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME));
  } catch {
    return false;
  }
}

export function recordR2EmergencyAlertSent(): void {
  inMemoryEmergencyAlertSent = true;
  try {
    const filePath = getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME);
    fs.writeFileSync(filePath, `Sent at ${new Date().toISOString()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error("[r2-usage] Failed saving emergency alert sent flag:", err);
  }
}

const R2_USAGE_GRAPHQL_QUERY = `
query R2FreeTierUsage(
  $accountTag: string!
  $startDate: Time
  $endDate: Time
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDate, datetime_leq: $endDate }
      ) {
        sum { requests }
        dimensions { actionType }
      }
      r2StorageAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDate, datetime_leq: $endDate }
        orderBy: [datetime_DESC]
      ) {
        max {
          objectCount
          uploadCount
          payloadSize
          metadataSize
        }
        dimensions {
          datetime
          bucketName
        }
      }
    }
  }
}
`;

function utcMonthStartIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  ).toISOString();
}

/**
 * Parse a Cloudflare GraphQL R2 analytics response into free-tier counters.
 * Exported for unit tests.
 */
export function parseR2GraphqlUsage(
  payload: unknown
): FetchedR2UsageMetrics {
  const root = payload as {
    data?: {
      viewer?: {
        accounts?: Array<{
          r2OperationsAdaptiveGroups?: Array<{
            sum?: { requests?: number | null } | null;
            dimensions?: { actionType?: string | null } | null;
          }>;
          r2StorageAdaptiveGroups?: Array<{
            max?: {
              objectCount?: number | null;
              uploadCount?: number | null;
              payloadSize?: number | null;
              metadataSize?: number | null;
            } | null;
            dimensions?: {
              datetime?: string | null;
              bucketName?: string | null;
            } | null;
          }>;
        }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const msg = root.errors
      .map((e) => e.message || "unknown")
      .slice(0, 3)
      .join("; ");
    throw new Error(`Cloudflare GraphQL errors: ${msg}`);
  }

  const accounts = root.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("Cloudflare GraphQL returned no accounts for R2 usage");
  }

  const account = accounts[0];
  const rawActionCounts: Record<string, number> = {};
  let classAOps = 0;
  let classBOps = 0;

  for (const group of account.r2OperationsAdaptiveGroups ?? []) {
    const action = group.dimensions?.actionType || "unknown";
    const n = Number(group.sum?.requests ?? 0);
    if (!Number.isFinite(n) || n < 0) continue;
    rawActionCounts[action] = (rawActionCounts[action] ?? 0) + n;
    if (classifyR2Action(action) === "B") classBOps += n;
    else classAOps += n;
  }

  // Latest sample per bucket (query is datetime_DESC).
  const latestByBucket = new Map<string, R2BucketStorageSample>();
  for (const group of account.r2StorageAdaptiveGroups ?? []) {
    const bucketName = group.dimensions?.bucketName || "(unknown)";
    const datetime = group.dimensions?.datetime ?? null;
    if (latestByBucket.has(bucketName)) continue;
    const payload = Number(group.max?.payloadSize ?? 0);
    const metadata = Number(group.max?.metadataSize ?? 0);
    const objectCount = Number(group.max?.objectCount ?? 0);
    const bytes =
      (Number.isFinite(payload) ? payload : 0) +
      (Number.isFinite(metadata) ? metadata : 0);
    latestByBucket.set(bucketName, {
      bucketName,
      bytes,
      objectCount: Number.isFinite(objectCount) ? objectCount : 0,
      asOf: datetime,
    });
  }

  const buckets = [...latestByBucket.values()].sort((a, b) => b.bytes - a.bytes);
  const storageBytes = buckets.reduce((sum, b) => sum + b.bytes, 0);

  return {
    storageBytes,
    classAOps,
    classBOps,
    buckets,
    rawActionCounts,
  };
}


export interface R2S3ListCredentials {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function resolveR2S3ListCredentials(
  env: Record<string, string | undefined> = process.env
): R2S3ListCredentials | null {
  const endpoint = (
    env.LITESTREAM_S3_ENDPOINT ||
    env.AWS_S3_ENDPOINT ||
    ""
  ).trim();
  const accessKeyId = (
    env.LITESTREAM_S3_ACCESS_KEY_ID ||
    env.AWS_ACCESS_KEY_ID ||
    ""
  ).trim();
  const secretAccessKey = (
    env.LITESTREAM_S3_SECRET_ACCESS_KEY ||
    env.AWS_SECRET_ACCESS_KEY ||
    ""
  ).trim();
  const region = (
    env.LITESTREAM_S3_REGION ||
    env.AWS_REGION ||
    "auto"
  ).trim() || "auto";
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  if (!isLitestreamR2Endpoint(endpoint)) return null;
  return { endpoint, region, accessKeyId, secretAccessKey };
}

/**
 * Buckets to ListObjects for live storage (Class A!). Prefer the litestream
 * primary only. Optional `R2_USAGE_EXTRA_BUCKETS` (comma-separated) for
 * receipts/legacy inventory. Do NOT hardcode every historical bucket — listing
 * large orphan buckets every maintenance tick burned free-tier Class A with no
 * product benefit (2026-08-05 free-tier survival).
 */
export function resolveR2StorageBucketNames(
  env: Record<string, string | undefined> = process.env
): string[] {
  const names = new Set<string>();
  const primary = (
    env.LITESTREAM_S3_BUCKET ||
    env.AWS_S3_BUCKET_NAME ||
    ""
  ).trim();
  if (primary) names.add(primary);
  const extra = (env.R2_USAGE_EXTRA_BUCKETS || "").trim();
  for (const part of extra.split(",")) {
    const n = part.trim();
    if (n) names.add(n);
  }
  // Fallback when env has no bucket name yet (local/dev): only the current prod
  // litestream target — not legacy usage-monitor-bucket (often multi-GiB orphans).
  if (names.size === 0) {
    names.add("usage-monitor-prod-v3");
  }
  return [...names];
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * ListObjectsV2 size sum for one R2 bucket via the same S3 credentials
 * Litestream uses. This is live inventory — not GraphQL analytics lag.
 */
export async function listR2BucketStorageViaS3(
  creds: R2S3ListCredentials,
  bucket: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2BucketStorageSample> {
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const host = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`
  ).host;
  const region = creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";
  let continuation: string | undefined;
  let bytes = 0;
  let objectCount = 0;
  let pages = 0;

  do {
    pages += 1;
    if (pages > 200) throw new Error(`ListObjectsV2 page cap for bucket ${bucket}`);
    const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
    if (continuation) qs.set("continuation-token", continuation);
    // Path-style: https://account.r2.cloudflarestorage.com/bucket?list-type=2
    const canonicalUri = `/${bucket}`;
    const queryPairs = [...qs.entries()]
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex("");
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${endpoint.startsWith("http") ? endpoint : `https://${endpoint}`}/${bucket}?${canonicalQuery}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ListObjectsV2 ${bucket} HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
    // Minimal XML parse for <Size> and NextContinuationToken / IsTruncated
    const sizeMatches = [...text.matchAll(/<Size>(\d+)<\/Size>/g)];
    for (const m of sizeMatches) {
      bytes += Number(m[1]) || 0;
      objectCount += 1;
    }
    // Contents count via Key tags is more accurate than Size alone when empty files
    const keyCount = (text.match(/<Key>/g) || []).length;
    if (keyCount > 0 && keyCount !== sizeMatches.length) {
      // Prefer key count for objectCount; sizes still summed from Size tags
      objectCount = keyCount;
    }
    const trunc = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text);
    const next = text.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
    );
    continuation = trunc && next ? next[1] : undefined;
  } while (continuation);

  return {
    bucketName: bucket,
    bytes,
    objectCount,
    asOf: now.toISOString(),
  };
}

export interface R2ObjectListing {
  key: string;
  size: number;
  lastModified?: string;
}

/**
 * Pure planner: keep newest tip (highest max-txid) per Litestream LTX level;
 * delete the rest. Non-LTX keys are always kept. Exported for unit tests.
 */
export function planLtxTipPrune(objects: R2ObjectListing[]): {
  keep: R2ObjectListing[];
  delete: R2ObjectListing[];
  byLevel: Record<string, { keep: string; deleteCount: number; freeBytes: number }>;
} {
  const byLevel = new Map<string, R2ObjectListing & { maxTx: number; minTx: number }[]>();
  const other: R2ObjectListing[] = [];
  for (const obj of objects) {
    const m = LTX_OBJECT_KEY_RE.exec(obj.key);
    if (!m?.groups) {
      other.push(obj);
      continue;
    }
    const levelKey = `${m.groups.prefix}${m.groups.level}`;
    const entry = {
      ...obj,
      minTx: Number.parseInt(m.groups.min, 16),
      maxTx: Number.parseInt(m.groups.max, 16),
    };
    const arr = byLevel.get(levelKey) ?? [];
    arr.push(entry);
    byLevel.set(levelKey, arr);
  }

  const keep: R2ObjectListing[] = [...other];
  const del: R2ObjectListing[] = [];
  const summary: Record<string, { keep: string; deleteCount: number; freeBytes: number }> =
    {};

  for (const [levelKey, items] of [...byLevel.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const sorted = items.slice().sort((a, b) => {
      if (a.maxTx !== b.maxTx) return a.maxTx - b.maxTx;
      if (a.minTx !== b.minTx) return a.minTx - b.minTx;
      return (a.lastModified ?? "").localeCompare(b.lastModified ?? "");
    });
    const tip = sorted[sorted.length - 1];
    keep.push({ key: tip.key, size: tip.size, lastModified: tip.lastModified });
    let freeBytes = 0;
    for (const it of sorted.slice(0, -1)) {
      del.push({ key: it.key, size: it.size, lastModified: it.lastModified });
      freeBytes += it.size;
    }
    summary[levelKey] = {
      keep: tip.key,
      deleteCount: sorted.length - 1,
      freeBytes,
    };
  }

  return { keep, delete: del, byLevel: summary };
}

/**
 * List full object keys+sizes for one bucket (Class A). Used by tip-prune.
 */
export async function listR2BucketObjectsViaS3(
  creds: R2S3ListCredentials,
  bucket: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2ObjectListing[]> {
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const host = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`
  ).host;
  const region = creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";
  let continuation: string | undefined;
  const objects: R2ObjectListing[] = [];
  let pages = 0;

  do {
    pages += 1;
    if (pages > 200) throw new Error(`ListObjectsV2 page cap for bucket ${bucket}`);
    const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
    if (continuation) qs.set("continuation-token", continuation);
    const canonicalUri = `/${bucket}`;
    const queryPairs = [...qs.entries()]
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex("");
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${endpoint.startsWith("http") ? endpoint : `https://${endpoint}`}/${bucket}?${canonicalQuery}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ListObjectsV2 ${bucket} HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
    // Parse Contents blocks for Key/Size/LastModified
    const contentBlocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
    for (const block of contentBlocks) {
      const key = block.match(/<Key>([^<]*)<\/Key>/)?.[1];
      const size = Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
      const lastModified = block.match(/<LastModified>([^<]*)<\/LastModified>/)?.[1];
      if (key) {
        objects.push({
          key,
          size: Number.isFinite(size) ? size : 0,
          lastModified,
        });
      }
    }
    const trunc = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text);
    const next = text.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
    );
    continuation = trunc && next ? next[1] : undefined;
  } while (continuation);

  return objects;
}

/**
 * DeleteObjects (up to 1000 keys per call). Class A. Returns deleted count.
 */
export async function deleteR2ObjectsViaS3(
  creds: R2S3ListCredentials,
  bucket: string,
  keys: string[],
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<{ deleted: number; errors: number }> {
  if (keys.length === 0) return { deleted: 0, errors: 0 };
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const host = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`
  ).host;
  const region = creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";
  let deleted = 0;
  let errors = 0;
  const BATCH = 500;

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><Delete>` +
      batch.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("") +
      `</Delete>`;
    const payload = Buffer.from(body, "utf8");
    const payloadHash = sha256Hex(payload);
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const canonicalUri = `/${bucket}`;
    const canonicalQuery = "delete=";
    const contentType = "application/xml";
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "POST",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${endpoint.startsWith("http") ? endpoint : `https://${endpoint}`}/${bucket}?delete=`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        host,
        "content-type": contentType,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
      body: payload,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `DeleteObjects ${bucket} HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
    const delCount = (text.match(/<Deleted>/g) || []).length;
    const errCount = (text.match(/<Error>/g) || []).length;
    deleted += delCount || batch.length;
    errors += errCount;
  }
  return { deleted, errors };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface R2TipPruneResult {
  attempted: boolean;
  deletedObjects: number;
  freedBytes: number;
  keptObjects: number;
  error?: string;
}

/**
 * If live storage ≥ soft threshold, tip-prune Litestream LTX on the primary
 * bucket. No-op when under threshold, missing creds, or nothing to delete.
 */
export async function pruneR2LtxTipsIfNeeded(
  storageBytes: number,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  limits: R2UsageLimits = DEFAULT_R2_FREE_TIER_LIMITS,
  softPct: number = R2_SOFT_PRUNE_STORAGE_PCT
): Promise<R2TipPruneResult> {
  const mtdPct = (storageBytes / limits.storageBytes) * 100;
  if (mtdPct < softPct) {
    return { attempted: false, deletedObjects: 0, freedBytes: 0, keptObjects: 0 };
  }
  const creds = resolveR2S3ListCredentials(env);
  if (!creds) {
    return {
      attempted: false,
      deletedObjects: 0,
      freedBytes: 0,
      keptObjects: 0,
      error: "S3 list credentials unavailable for tip-prune",
    };
  }
  const bucket = (
    env.LITESTREAM_S3_BUCKET ||
    env.AWS_S3_BUCKET_NAME ||
    ""
  ).trim();
  if (!bucket) {
    return {
      attempted: false,
      deletedObjects: 0,
      freedBytes: 0,
      keptObjects: 0,
      error: "no primary litestream bucket for tip-prune",
    };
  }

  try {
    const objects = await listR2BucketObjectsViaS3(creds, bucket, fetchImpl, now);
    const plan = planLtxTipPrune(objects);
    if (plan.delete.length === 0) {
      return {
        attempted: true,
        deletedObjects: 0,
        freedBytes: 0,
        keptObjects: plan.keep.length,
      };
    }
    const freedBytes = plan.delete.reduce((s, o) => s + o.size, 0);
    const { deleted, errors } = await deleteR2ObjectsViaS3(
      creds,
      bucket,
      plan.delete.map((o) => o.key),
      fetchImpl,
      now
    );
    invalidateLiveR2StorageCache();
    console.warn(
      `[r2-usage] tip-prune ${bucket}: deleted=${deleted} errors=${errors} ` +
        `freedGiB=${(freedBytes / (1024 * 1024 * 1024)).toFixed(3)} ` +
        `kept=${plan.keep.length} (storage was ${mtdPct.toFixed(1)}% ≥ soft ${softPct}%)`
    );
    return {
      attempted: true,
      deletedObjects: deleted,
      freedBytes,
      keptObjects: plan.keep.length,
      error: errors > 0 ? `${errors} DeleteObjects errors` : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[r2-usage] tip-prune failed: ${message}`);
    return {
      attempted: true,
      deletedObjects: 0,
      freedBytes: 0,
      keptObjects: 0,
      error: message,
    };
  }
}

/** In-process cache for live ListObjects inventory (Class A). Default 6h. */
const LIVE_S3_LIST_CACHE_MS = (() => {
  const raw = process.env.R2_LIVE_LIST_CACHE_HOURS?.trim();
  const n = raw ? Number(raw) : 6;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n * 3600_000) : 6 * 3600_000;
})();

/**
 * While kill-switch is on, re-list at most this often so an external tip-prune
 * can auto-resume within an hour. The previous 24h killed-cache stuck storage
 * at the pre-prune value and blocked resume after ops deleted LTX.
 */
const LIVE_S3_LIST_CACHE_WHILE_KILLED_MS = 60 * 60 * 1000;

/** Test/ops: drop the live ListObjects cache so the next check re-lists. */
export function invalidateLiveR2StorageCache(): void {
  liveS3ListCache = null;
}

export async function fetchLiveR2StorageViaS3(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env
): Promise<{ storageBytes: number; buckets: R2BucketStorageSample[] } | null> {
  // Cache ListObjects (Class A). While killed, cap cache at 1h so tip-prunes
  // are visible for auto-resume without listing every 15m maintenance tick.
  if (LIVE_S3_LIST_CACHE_MS > 0 && liveS3ListCache) {
    const maxAge = isR2AutoDisabled()
      ? Math.min(LIVE_S3_LIST_CACHE_MS, LIVE_S3_LIST_CACHE_WHILE_KILLED_MS)
      : LIVE_S3_LIST_CACHE_MS;
    if (now.getTime() - liveS3ListCache.atMs < maxAge) {
      return liveS3ListCache.value;
    }
  }

  const creds = resolveR2S3ListCredentials(env);
  if (!creds) return null;
  const names = resolveR2StorageBucketNames(env);
  const buckets: R2BucketStorageSample[] = [];
  for (const name of names) {
    try {
      const sample = await listR2BucketStorageViaS3(creds, name, fetchImpl, now);
      buckets.push(sample);
    } catch (err) {
      // AccessDenied / NoSuchBucket are expected for unrelated names.
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|NoSuchBucket|AccessDenied|403|InvalidAccessKeyId/i.test(msg)) {
        continue;
      }
      console.warn(`[r2-usage] live list failed for bucket ${name}: ${msg}`);
    }
  }
  if (buckets.length === 0) return null;
  buckets.sort((a, b) => b.bytes - a.bytes);
  const storageBytes = buckets.reduce((s, b) => s + b.bytes, 0);
  const value = { storageBytes, buckets };
  liveS3ListCache = { atMs: now.getTime(), value };
  return value;
}

export function graphqlStorageSamplesAreFresh(
  buckets: R2BucketStorageSample[],
  now: Date = new Date(),
  maxAgeMs: number = R2_GRAPHQL_STORAGE_MAX_AGE_MS
): boolean {
  if (buckets.length === 0) return false;
  return buckets.every((b) => {
    if (!b.asOf) return false;
    const t = Date.parse(b.asOf);
    return Number.isFinite(t) && now.getTime() - t <= maxAgeMs;
  });
}



/**
 * Fetch account-wide R2 storage + Class A/B ops for the current UTC month
 * from Cloudflare GraphQL analytics.
 */
export async function fetchR2UsageMetrics(
  credentials: R2UsageCredentials,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<FetchedR2UsageMetrics> {
  const body = JSON.stringify({
    query: R2_USAGE_GRAPHQL_QUERY,
    variables: {
      accountTag: credentials.accountId,
      startDate: utcMonthStartIso(now),
      endDate: now.toISOString(),
    },
  });

  const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      "content-type": "application/json",
    },
    body,
  });

  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Cloudflare GraphQL returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Cloudflare GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`
    );
  }

  return parseR2GraphqlUsage(payload);
}

// ── Fleet (3 Cloudflare accounts = 3 free tiers) ─────────────────────────────
// Owner ops hub: show ST / CT / UM R2 free-tier side-by-side on the dashboard.
// Kill-switch still only runs against THIS app's Jay/UM account via runR2UsageCheck.

export type R2FleetAppId = "um" | "st" | "ct";

export interface R2FleetAccountConfig {
  id: R2FleetAppId;
  label: string;
  accountId: string;
  apiToken: string;
}

export interface R2FleetAccountSnapshot {
  id: R2FleetAppId;
  label: string;
  /** Last 8 chars of account id for operator correlation (no secrets). */
  accountIdSuffix: string | null;
  configured: boolean;
  status: "ok" | "error" | "unconfigured";
  error?: string;
  storage: R2MetricStatus | null;
  classA: R2MetricStatus | null;
  classB: R2MetricStatus | null;
  overallOnTrackToExceed70Pct: boolean;
  metricsSource: R2MetricsSource | "unconfigured";
  buckets: Array<{ bucketName: string; bytes: number }>;
  /** True only for the Usage Monitor (Jay) account when this host's kill flag is set. */
  autoDisabled?: boolean;
  litestreamUsesR2?: boolean;
}

export interface R2FleetSummary {
  configured: boolean;
  thresholdPct: number;
  freeTier: {
    storageBytes: number;
    classAOps: number;
    classBOps: number;
  };
  accounts: R2FleetAccountSnapshot[];
  anyOnTrackToExceed: boolean;
  fetchedAt: string;
  /** Local litestream/kill state for this host (UM only). */
  localBackup: {
    autoDisabled: boolean;
    litestreamUsesR2: boolean;
  };
}

const FLEET_SLOTS: Array<{
  id: R2FleetAppId;
  label: string;
  accountEnv: string[];
  tokenEnv: string[];
}> = [
  {
    id: "um",
    label: "Usage Monitor",
    accountEnv: ["R2_USAGE_ACCOUNT_ID", "CLOUDFLARE_JAY_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"],
    tokenEnv: ["R2_USAGE_API_TOKEN", "CLOUDFLARE_JAY_API_TOKEN", "CLOUDFLARE_API_TOKEN"],
  },
  {
    id: "st",
    label: "Socratic Trade",
    accountEnv: ["CLOUDFLARE_ST_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_ST_API_TOKEN"],
  },
  {
    id: "ct",
    label: "Congress.Trade",
    accountEnv: ["CLOUDFLARE_CT_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_CT_API_TOKEN"],
  },
];

function firstEnv(
  env: Record<string, string | undefined>,
  keys: string[]
): string {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return "";
}

/**
 * Load any configured fleet account credentials (ST / CT / UM).
 * Unset slots are skipped so a subset still works.
 */
export function loadR2FleetAccounts(
  env: Record<string, string | undefined> = process.env
): R2FleetAccountConfig[] {
  const out: R2FleetAccountConfig[] = [];
  for (const slot of FLEET_SLOTS) {
    const accountId = firstEnv(env, slot.accountEnv);
    const apiToken = firstEnv(env, slot.tokenEnv);
    if (accountId && apiToken) {
      out.push({
        id: slot.id,
        label: slot.label,
        accountId,
        apiToken,
      });
    }
  }
  return out;
}

function emptyMetric(): R2MetricStatus {
  return {
    actual: 0,
    limit: 0,
    mtdPct: 0,
    projected: 0,
    projectedPct: 0,
    onTrackToExceed: false,
  };
}

function unconfiguredAccount(
  id: R2FleetAppId,
  label: string
): R2FleetAccountSnapshot {
  return {
    id,
    label,
    accountIdSuffix: null,
    configured: false,
    status: "unconfigured",
    storage: null,
    classA: null,
    classB: null,
    overallOnTrackToExceed70Pct: false,
    metricsSource: "unconfigured",
    buckets: [],
  };
}

/**
 * Read-only fleet snapshot for the Ops dashboard. Does **not** engage the
 * kill-switch (that remains UM-only in {@link runR2UsageCheck}).
 */
export async function fetchR2FleetSummary(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env
): Promise<R2FleetSummary> {
  const configured = loadR2FleetAccounts(env);
  const byId = new Map(configured.map((a) => [a.id, a]));
  const accounts: R2FleetAccountSnapshot[] = [];

  for (const slot of FLEET_SLOTS) {
    const cfg = byId.get(slot.id);
    if (!cfg) {
      accounts.push(unconfiguredAccount(slot.id, slot.label));
      continue;
    }
    try {
      const metrics = await fetchR2UsageMetrics(
        { accountId: cfg.accountId, apiToken: cfg.apiToken },
        now,
        fetchImpl
      );
      // For UM only, prefer live S3 list for storage when credentials match
      // this host's litestream bucket (authoritative inventory).
      let storageBytes = metrics.storageBytes;
      let buckets = metrics.buckets;
      let source: R2MetricsSource = "cloudflare_graphql";
      if (slot.id === "um") {
        const live = await fetchLiveR2StorageViaS3(fetchImpl, now);
        if (live) {
          storageBytes = live.storageBytes;
          buckets = live.buckets;
          source = "live_s3_storage+graphql_ops";
        }
      }
      const assessment = assessR2Usage(
        storageBytes,
        metrics.classAOps,
        metrics.classBOps,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        { metricsSource: source, buckets }
      );
      accounts.push({
        id: slot.id,
        label: slot.label,
        accountIdSuffix: cfg.accountId.slice(-8),
        configured: true,
        status: "ok",
        storage: assessment.storage,
        classA: assessment.classA,
        classB: assessment.classB,
        overallOnTrackToExceed70Pct: assessment.overallOnTrackToExceed70Pct,
        metricsSource: source,
        buckets: buckets.map((b) => ({
          bucketName: b.bucketName,
          bytes: b.bytes,
        })),
        autoDisabled: slot.id === "um" ? isR2AutoDisabled() : undefined,
        litestreamUsesR2:
          slot.id === "um" ? isLitestreamR2Endpoint() : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      accounts.push({
        id: slot.id,
        label: slot.label,
        accountIdSuffix: cfg.accountId.slice(-8),
        configured: true,
        status: "error",
        error: message,
        storage: emptyMetric(),
        classA: emptyMetric(),
        classB: emptyMetric(),
        overallOnTrackToExceed70Pct: false,
        metricsSource: "unavailable",
        buckets: [],
      });
    }
  }

  return {
    configured: configured.length > 0,
    thresholdPct: R2_THRESHOLD_PCT,
    freeTier: {
      storageBytes: DEFAULT_R2_FREE_TIER_LIMITS.storageBytes,
      classAOps: DEFAULT_R2_FREE_TIER_LIMITS.classAOps,
      classBOps: DEFAULT_R2_FREE_TIER_LIMITS.classBOps,
    },
    accounts,
    anyOnTrackToExceed: accounts.some((a) => a.overallOnTrackToExceed70Pct),
    fetchedAt: now.toISOString(),
    localBackup: {
      autoDisabled: isR2AutoDisabled(),
      litestreamUsesR2: isLitestreamR2Endpoint(),
    },
  };
}

export async function runR2UsageCheck(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2UsageAssessment> {
  const credentials = resolveR2UsageCredentials();
  let assessment: R2UsageAssessment;
  const failClosed = r2FreeTierFailClosedRequired();
  let storageIsLive = false;
  let storageSampleStale = false;

  // Live S3 inventory is authoritative for storage (GraphQL lag caused a late
  // false 15 GiB kill after the bucket was already emptied).
  const liveStorage = await fetchLiveR2StorageViaS3(fetchImpl, now);

  if (!credentials) {
    if (liveStorage) {
      // Ops unknown without GraphQL; storage is live. Enforce storage-only.
      assessment = assessR2Usage(
        liveStorage.storageBytes,
        0,
        0,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        {
          metricsSource: "live_s3_storage+graphql_ops",
          metricsError:
            "GraphQL analytics credentials missing — Class A/B ops not measured; storage from live S3 list",
          buckets: liveStorage.buckets,
        }
      );
      // Zero ops will not trip ops thresholds; storage will if absolute ≥ 70%.
      storageIsLive = true;
      console.warn(
        "[r2-usage] GraphQL credentials missing; enforcing storage from live S3 list only"
      );
    } else {
      const errMsg =
        "R2 usage credentials not configured (set R2_USAGE_ACCOUNT_ID + R2_USAGE_API_TOKEN, or CLOUDFLARE_JAY_ACCOUNT_ID + CLOUDFLARE_JAY_API_TOKEN) and live S3 list unavailable";
      assessment = assessR2Usage(0, 0, 0, DEFAULT_R2_FREE_TIER_LIMITS, now, {
        metricsSource: "unavailable",
        metricsError: errMsg,
      });
      if (failClosed) {
        console.error(
          "[r2-usage] FAIL CLOSED: cannot measure R2 free tier with R2 Litestream in production — disabling R2 writes"
        );
        if (!isR2AutoDisabled()) {
          enforceR2AutoDisable(
            `fail-closed: ${errMsg} (cannot enforce ${R2_THRESHOLD_PCT}% free-tier policy blind)`
          );
        }
      } else {
        console.warn(
          "[r2-usage] skipping free-tier enforcement (non-production): no live S3 list and no GraphQL credentials"
        );
      }
    }
  } else {
    try {
      const metrics = await fetchR2UsageMetrics(credentials, now, fetchImpl);
      let storageBytes = metrics.storageBytes;
      let buckets = metrics.buckets;
      let source: R2MetricsSource = "cloudflare_graphql";

      if (liveStorage) {
        storageBytes = liveStorage.storageBytes;
        buckets = liveStorage.buckets;
        source = "live_s3_storage+graphql_ops";
        storageIsLive = true;
      } else if (!graphqlStorageSamplesAreFresh(metrics.buckets, now)) {
        // Stale GraphQL storage caused a delayed false 15 GiB alert after prune.
        // Refuse to kill on storage when samples are old; still enforce ops.
        storageSampleStale = true;
        storageBytes = 0;
        console.warn(
          "[r2-usage] GraphQL storage samples are stale; ignoring storage for kill decisions (ops still enforced)"
        );
      }

      assessment = assessR2Usage(
        storageBytes,
        metrics.classAOps,
        metrics.classBOps,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        {
          metricsSource: source,
          buckets,
          metricsError: storageSampleStale
            ? "GraphQL storage samples stale; storage kill deferred until live list or fresh sample"
            : undefined,
        }
      );

      // If storage was zeroed due to stale GraphQL, do not treat storage as breached.
      if (storageSampleStale && assessment.exceededMetric === "storage") {
        assessment = {
          ...assessment,
          overallOnTrackToExceed70Pct:
            assessment.classA.onTrackToExceed || assessment.classB.onTrackToExceed,
          exceededMetric: assessment.classA.onTrackToExceed
            ? "classA"
            : assessment.classB.onTrackToExceed
              ? "classB"
              : undefined,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[r2-usage] failed to fetch Cloudflare R2 metrics:", message);
      if (liveStorage) {
        assessment = assessR2Usage(
          liveStorage.storageBytes,
          0,
          0,
          DEFAULT_R2_FREE_TIER_LIMITS,
          now,
          {
            metricsSource: "live_s3_storage+graphql_ops",
            metricsError: `GraphQL failed (${message}); storage from live S3 list`,
            buckets: liveStorage.buckets,
          }
        );
        storageIsLive = true;
      } else {
        assessment = assessR2Usage(0, 0, 0, DEFAULT_R2_FREE_TIER_LIMITS, now, {
          metricsSource: "unavailable",
          metricsError: message,
        });
        if (failClosed && !isR2AutoDisabled()) {
          enforceR2AutoDisable(
            `fail-closed: R2 metrics unavailable (${message}) — cannot enforce ${R2_THRESHOLD_PCT}% free-tier policy blind`
          );
        }
      }
    }
  }

  assessment.storageIsLive = storageIsLive;
  assessment.storageSampleStale = storageSampleStale;

  // Soft tip-prune before kill: multi-level LTX history is DR-optional; free
  // tier is not. Re-list after a successful prune so kill/resume use new bytes.
  if (
    storageIsLive &&
    assessment.storage.mtdPct >= R2_SOFT_PRUNE_STORAGE_PCT &&
    isLitestreamR2Endpoint()
  ) {
    const prune = await pruneR2LtxTipsIfNeeded(
      assessment.storage.actual,
      fetchImpl,
      now
    );
    if (prune.attempted && prune.deletedObjects > 0) {
      const refreshed = await fetchLiveR2StorageViaS3(fetchImpl, now);
      if (refreshed) {
        const opsA = assessment.classA.actual;
        const opsB = assessment.classB.actual;
        assessment = assessR2Usage(
          refreshed.storageBytes,
          opsA,
          opsB,
          DEFAULT_R2_FREE_TIER_LIMITS,
          now,
          {
            metricsSource: "live_s3_storage+graphql_ops",
            buckets: refreshed.buckets,
            metricsError: assessment.metricsError,
          }
        );
        assessment.storageIsLive = true;
        storageIsLive = true;
      }
    }
  }

  // Kill only on trustworthy measurements — never on stale GraphQL storage alone.
  // Storage kill requires a trustworthy sample: live S3 list, or fresh GraphQL
  // (stale GraphQL storage is zeroed above and must never re-alert hours late).
  const mayKillStorage =
    assessment.exceededMetric === "storage" && !storageSampleStale;
  const mayKillOps =
    assessment.exceededMetric === "classA" ||
    assessment.exceededMetric === "classB";
  const shouldKill =
    assessment.metricsSource !== "unavailable" &&
    assessment.overallOnTrackToExceed70Pct &&
    (mayKillStorage || mayKillOps) &&
    !isR2AutoDisabled();

  if (shouldKill) {
    const metric = assessment.exceededMetric || "storage";
    const status = assessment[metric];
    const reason =
      metric === "storage"
        ? `R2 free-tier absolute storage ≥ ${R2_THRESHOLD_PCT}% (live MTD ${status.mtdPct}%)`
        : `R2 free-tier ${metric} ≥ ${R2_THRESHOLD_PCT}% absolute or projected (MTD ${status.mtdPct}%, projected ${status.projectedPct}%)`;
    enforceR2AutoDisable(reason);
  }

  // Auto-resume when live storage is healthy (hysteresis) and ops are fine.
  // Fixes sticky kill from stale GraphQL after a successful prune.
  if (
    isR2AutoDisabled() &&
    storageIsLive &&
    assessment.storage.mtdPct < R2_RESUME_STORAGE_PCT &&
    !assessment.classA.onTrackToExceed &&
    !assessment.classB.onTrackToExceed
  ) {
    console.warn(
      `[r2-usage] auto-resume: live storage ${assessment.storage.mtdPct}% < ${R2_RESUME_STORAGE_PCT}% resume threshold; clearing kill switch`
    );
    clearR2AutoDisable();
  }

  assessment.autoDisabled = isR2AutoDisabled();
  assessment.litestreamUsesR2 = isLitestreamR2Endpoint();

  // Retry priority-1 emergency notification until successfully delivered
  if (isR2AutoDisabled() && !isR2EmergencyAlertSent()) {
    const metric = assessment.exceededMetric || "storage";
    const status = assessment[metric];
    const alertTitle = "🚨 ALERT: Cloudflare R2 Free Tier Kill Switch";
    const alertBody = [
      `R2 free-tier usage reached ${R2_THRESHOLD_PCT}% threshold.`,
      `Metric: ${metric}`,
      `MTD: ${status.mtdPct}%  Projected: ${status.projectedPct}%`,
      `Storage: ${(assessment.storage.actual / (1024 * 1024 * 1024)).toFixed(2)} / 10.00 GiB`,
      `Class A: ${assessment.classA.actual.toLocaleString()} / 1,000,000`,
      `Class B: ${assessment.classB.actual.toLocaleString()} / 10,000,000`,
      `Source: ${assessment.metricsSource}`,
      `Litestream→R2: ${assessment.litestreamUsesR2 ? "yes (replication stopped/blocked)" : "no (endpoint not detected as R2)"}`,
      `Flag: /data/${R2_DISABLED_FLAG_FILENAME}`,
      `This alert is from Usage Monitor (PUSHOVER_USAGE_API_TOKEN), not a peer app.`,
    ].join("\n");

    const res = await sendPushoverNotification(
      alertTitle,
      alertBody,
      1,
      fetchImpl
    );
    if (res.ok) {
      recordR2EmergencyAlertSent();
    } else {
      console.error(
        "[r2-usage] emergency Pushover not delivered (will retry next tick):",
        res.error
      );
    }
  }

  const todayStr = now.toISOString().slice(0, 10);
  if (getLastDailyPushoverDate() !== todayStr) {
    const { title, body } = formatDailyPushoverMessage(
      assessment,
      isR2AutoDisabled()
    );
    const res = await sendPushoverNotification(title, body, 0, fetchImpl);
    if (res.ok) {
      recordDailyPushoverSent(todayStr);
    }
  }

  return assessment;
}
