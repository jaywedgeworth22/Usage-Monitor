import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cloudflare R2 free-tier monitor + automatic shutoff.
 *
 * Free tier (account-wide, resets monthly):
 *   - Storage: 10 GB-month
 *   - Class A ops: 1,000,000 / month
 *   - Class B ops: 10,000,000 / month
 *
 * When any metric's MTD share or linear month-end projection reaches
 * {@link R2_THRESHOLD_PCT} (70%), we:
 *   1. Persist `/data/r2-disabled-70pct.flag` (and set env)
 *   2. Alert via Pushover using the Usage Monitor app token
 *      (`PUSHOVER_USAGE_API_TOKEN`, then generic fallbacks) — this app owns
 *      its own free-tier alerts; peer apps (Socratic.Trade) must not be the
 *      only notifier.
 *   3. Stop *R2-backed* Litestream writes (startup gate + runtime watcher).
 *      Production backups target Cloudflare R2 only. The former Coolify-hosted
 *      Garage replica is retired/gone — free-tier limits apply to R2.
 *
 * Metrics come from Cloudflare GraphQL analytics (same source as the R2
 * dashboard). Local SQLite size and day-of-month stubs are never used.
 *
 * Required credentials (either pair):
 *   - `R2_USAGE_ACCOUNT_ID` + `R2_USAGE_API_TOKEN`, or
 *   - `CLOUDFLARE_JAY_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID` +
 *     `CLOUDFLARE_JAY_API_TOKEN` / `CLOUDFLARE_API_TOKEN`
 * Without analytics credentials the check logs `metricsSource: unavailable`
 * and will NOT auto-disable (it refuses to fake local DB size as R2 usage).
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

export type R2MetricsSource = "cloudflare_graphql" | "unavailable";

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

export function calculatePaceProjection(
  actual: number,
  limit: number,
  now: Date = new Date(),
  thresholdPct: number = R2_THRESHOLD_PCT
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
  // Trip on either current share or projected month-end pace. Storage is a
  // stock (already-at-70% must kill even late in the month); ops are flows
  // where early-month pace projection is the main signal.
  const onTrackToExceed =
    projectedPct >= thresholdPct || mtdPct >= thresholdPct;

  return {
    actual,
    limit,
    mtdPct: Number(mtdPct.toFixed(2)),
    projected: Number(projected.toFixed(2)),
    projectedPct: Number(projectedPct.toFixed(2)),
    onTrackToExceed,
  };
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
  const storage = calculatePaceProjection(
    actualStorageBytes,
    limits.storageBytes,
    now
  );
  const classA = calculatePaceProjection(actualClassAOps, limits.classAOps, now);
  const classB = calculatePaceProjection(actualClassBOps, limits.classBOps, now);

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

/** Clear the free-tier kill switch so the next container start can resume R2 litestream. */
export function clearR2AutoDisable(): boolean {
  process.env.LITESTREAM_EMERGENCY_DISABLE = "false";
  process.env.R2_WRITES_DISABLED = "false";
  try {
    const filePath = getFlagFilePath(R2_DISABLED_FLAG_FILENAME);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const alertPath = getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME);
    if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath);
    return true;
  } catch (err) {
    console.error("[r2-usage] Failed clearing emergency disable flag:", err);
    return false;
  }
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

export async function runR2UsageCheck(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2UsageAssessment> {
  const credentials = resolveR2UsageCredentials();
  let assessment: R2UsageAssessment;

  if (!credentials) {
    assessment = assessR2Usage(0, 0, 0, DEFAULT_R2_FREE_TIER_LIMITS, now, {
      metricsSource: "unavailable",
      metricsError:
        "R2 usage credentials not configured (set R2_USAGE_ACCOUNT_ID + R2_USAGE_API_TOKEN, or CLOUDFLARE_JAY_ACCOUNT_ID + CLOUDFLARE_JAY_API_TOKEN)",
    });
    console.warn(
      "[r2-usage] skipping free-tier enforcement: Cloudflare analytics credentials not configured"
    );
  } else {
    try {
      const metrics = await fetchR2UsageMetrics(credentials, now, fetchImpl);
      assessment = assessR2Usage(
        metrics.storageBytes,
        metrics.classAOps,
        metrics.classBOps,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        {
          metricsSource: "cloudflare_graphql",
          buckets: metrics.buckets,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[r2-usage] failed to fetch Cloudflare R2 metrics:", message);
      assessment = assessR2Usage(0, 0, 0, DEFAULT_R2_FREE_TIER_LIMITS, now, {
        metricsSource: "unavailable",
        metricsError: message,
      });
    }
  }

  // Only auto-disable on real metrics. Fake/local proxies previously hid a
  // 90%+ free-tier breach by reporting local SQLite size instead of R2.
  if (
    assessment.metricsSource === "cloudflare_graphql" &&
    assessment.overallOnTrackToExceed70Pct &&
    !isR2AutoDisabled()
  ) {
    const metric = assessment.exceededMetric || "storage";
    const status = assessment[metric];
    const reason = `R2 free-tier pace/MTD reached ${R2_THRESHOLD_PCT}% on ${metric} (MTD ${status.mtdPct}%, projected ${status.projectedPct}%)`;
    enforceR2AutoDisable(reason);
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
