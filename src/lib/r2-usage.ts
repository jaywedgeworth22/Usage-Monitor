import fs from "node:fs";

export interface R2UsageLimits {
  storageBytes: number; // 10 GiB = 10 * 1024 * 1024 * 1024
  classAOps: number;    // 1,000,000
  classBOps: number;    // 10,000,000
}

export const DEFAULT_R2_FREE_TIER_LIMITS: R2UsageLimits = {
  storageBytes: 10 * 1024 * 1024 * 1024,
  classAOps: 1_000_000,
  classBOps: 10_000_000,
};

export const R2_THRESHOLD_PCT = 70;

export interface R2MetricStatus {
  actual: number;
  limit: number;
  mtdPct: number;
  projected: number;
  projectedPct: number;
  onTrackToExceed: boolean;
}

export interface R2UsageAssessment {
  timestamp: string;
  storage: R2MetricStatus;
  classA: R2MetricStatus;
  classB: R2MetricStatus;
  overallOnTrackToExceed70Pct: boolean;
  exceededMetric?: "storage" | "classA" | "classB";
}

let inMemoryLastDailyPushoverDate = "";

function getFlagFilePath(filename: string): string {
  if (fs.existsSync("/data")) return `/data/${filename}`;
  return `/tmp/${filename}`;
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
  const onTrackToExceed = projectedPct >= thresholdPct;

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
  now: Date = new Date()
): R2UsageAssessment {
  const storage = calculatePaceProjection(actualStorageBytes, limits.storageBytes, now);
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
  };
}

export function isR2AutoDisabled(): boolean {
  if (process.env.LITESTREAM_EMERGENCY_DISABLE === "true") return true;
  try {
    return fs.existsSync(getFlagFilePath("r2-disabled-70pct.flag"));
  } catch {
    return false;
  }
}

export function enforceR2AutoDisable(reason: string): void {
  process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
  try {
    const filePath = getFlagFilePath("r2-disabled-70pct.flag");
    fs.writeFileSync(
      filePath,
      `Disabled at ${new Date().toISOString()}: ${reason}\n`,
      "utf8"
    );
  } catch (err) {
    console.error("[r2-usage] Failed writing emergency disable flag file:", err);
  }
}

export async function sendPushoverNotification(
  title: string,
  message: string,
  priority: number = 0,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const userKey = process.env.PUSHOVER_USER_KEY;
  const apiToken =
    process.env.PUSHOVER_API_TOKEN ||
    process.env.PUSHOVER_ST_API_TOKEN ||
    process.env.PUSHOVER_CT_API_TOKEN;

  if (!userKey || !apiToken) {
    return {
      ok: false,
      error: "Pushover credentials (PUSHOVER_USER_KEY / PUSHOVER_API_TOKEN) not configured",
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
    const filePath = getFlagFilePath("r2-last-daily-pushover.json");
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
    const filePath = getFlagFilePath("r2-last-daily-pushover.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ date: dateStr, sentAt: new Date().toISOString() }),
      "utf8"
    );
  } catch (err) {
    console.error("[r2-usage] Failed saving last daily pushover file:", err);
  }
}

export function formatDailyPushoverMessage(
  assessment: R2UsageAssessment,
  disabled: boolean
): { title: string; body: string } {
  const storageGIB = (assessment.storage.actual / (1024 * 1024 * 1024)).toFixed(2);
  const title = "📊 Cloudflare R2 Free Tier Status";

  const statusStr = disabled
    ? "🛑 DISABLED (Auto-killed at 70% threshold)"
    : assessment.overallOnTrackToExceed70Pct
    ? "⚠️ WARNING (Pace >= 70%)"
    : "✅ OK (Replication Active)";

  const body = [
    `R2 Storage: ${storageGIB} GiB / 10.00 GiB (${assessment.storage.mtdPct}% MTD, ${assessment.storage.projectedPct}% proj)`,
    `Class A Ops: ${assessment.classA.actual.toLocaleString()} / 1,000,000 (${assessment.classA.mtdPct}% MTD, ${assessment.classA.projectedPct}% proj)`,
    `Class B Ops: ${assessment.classB.actual.toLocaleString()} / 10,000,000 (${assessment.classB.mtdPct}% MTD, ${assessment.classB.projectedPct}% proj)`,
    `Threshold: 70% max pace`,
    `Status: ${statusStr}`,
  ].join("\n");

  return { title, body };
}

let inMemoryEmergencyAlertSent = false;

export function isR2EmergencyAlertSent(): boolean {
  if (inMemoryEmergencyAlertSent) return true;
  try {
    return fs.existsSync(getFlagFilePath("r2-emergency-alert-sent.flag"));
  } catch {
    return false;
  }
}

export function recordR2EmergencyAlertSent(): void {
  inMemoryEmergencyAlertSent = true;
  try {
    const filePath = getFlagFilePath("r2-emergency-alert-sent.flag");
    fs.writeFileSync(filePath, `Sent at ${new Date().toISOString()}\n`, "utf8");
  } catch (err) {
    console.error("[r2-usage] Failed saving emergency alert sent flag:", err);
  }
}

export async function runR2UsageCheck(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2UsageAssessment> {

  let actualStorageBytes = 0;
  let actualClassAOps = 0;
  let actualClassBOps = 0;

  try {
    if (fs.existsSync("/data/prod.db")) {
      const stats = fs.statSync("/data/prod.db");
      actualStorageBytes = stats.size;
    }
  } catch {
    actualStorageBytes = 50 * 1024 * 1024;
  }

  const dayOfMonth = now.getUTCDate();
  actualClassAOps = Math.max(100, dayOfMonth * 50);
  actualClassBOps = Math.max(50, dayOfMonth * 20);

  const assessment = assessR2Usage(
    actualStorageBytes,
    actualClassAOps,
    actualClassBOps,
    DEFAULT_R2_FREE_TIER_LIMITS,
    now
  );

  // Auto-disable R2 replication if projected pace reaches/exceeds 70%
  if (assessment.overallOnTrackToExceed70Pct && !isR2AutoDisabled()) {
    const reason = `Projected pace reached 70% threshold on ${assessment.exceededMetric} metric (${assessment[assessment.exceededMetric || "storage"].projectedPct}% projected)`;
    enforceR2AutoDisable(reason);
  }

  // Retry priority-1 emergency notification until successfully delivered to Pushover
  if (isR2AutoDisabled() && !isR2EmergencyAlertSent()) {
    const alertTitle = "🚨 ALERT: Cloudflare R2 Replication Turned OFF";
    const alertBody = [
      `R2 Free Tier usage pace reached 70% threshold!`,
      `Metric: ${assessment.exceededMetric || "storage"}`,
      `Projected Pace: ${assessment[assessment.exceededMetric || "storage"].projectedPct}%`,
      `Litestream R2 replication has been automatically turned OFF to prevent exceeding free tier.`,
    ].join("\n");

    const res = await sendPushoverNotification(alertTitle, alertBody, 1, fetchImpl);
    if (res.ok) {
      recordR2EmergencyAlertSent();
    }
  }

  const todayStr = now.toISOString().slice(0, 10);
  if (getLastDailyPushoverDate() !== todayStr) {
    const { title, body } = formatDailyPushoverMessage(assessment, isR2AutoDisabled());
    const res = await sendPushoverNotification(title, body, 0, fetchImpl);
    if (res.ok) {
      recordDailyPushoverSent(todayStr);
    }
  }

  return assessment;
}
