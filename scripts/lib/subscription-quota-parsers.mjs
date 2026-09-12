// Pure parsers for each provider's subscription-quota response.
//
// Every function here is total: it takes whatever JSON the endpoint returned
// and yields QuotaWindowReading[] (see scripts/lib/quota-event.mjs), never
// throwing and never reading a credential.  That is deliberate — the shapes
// below are best-known from community CLIs, not a documented contract, so each
// parser accepts several plausible field names and reports
// `remainingUnknown: true` rather than guessing when none of them match.
//
// Fixtures live in scripts/__tests__/fixtures/.

import { clampPercent, toIsoTimestamp, windowLabelFromSeconds } from "./quota-event.mjs";

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function firstNumber(record, keys) {
  for (const key of keys) {
    const value = record[key];
    const n = Number(value);
    if (value != null && value !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstTimestamp(record, keys) {
  for (const key of keys) {
    if (!(key in record)) continue;
    const iso = toIsoTimestamp(record[key]);
    if (iso) return iso;
  }
  return null;
}

function reading(partial) {
  const remainingPercent = partial.remainingUnknown ? null : clampPercent(partial.remainingPercent);
  return {
    bucketId: partial.bucketId,
    label: partial.label,
    quotaWindow: partial.quotaWindow ?? null,
    remainingPercent,
    usedPercent: partial.usedPercent ?? null,
    resetAt: partial.resetAt ?? null,
    planType: partial.planType ?? null,
    modelId: partial.modelId ?? null,
    remainingUnknown: Boolean(partial.remainingUnknown),
    isExhausted: Boolean(partial.isExhausted) || remainingPercent === 0,
  };
}

// ---------------------------------------------------------------- Claude ----

const WORD_NUMBERS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  thirty: 30,
};

const UNIT_SUFFIX = { hour: "h", day: "d", week: "w", month: "mo" };

/** "five_hour" -> "5h", "seven_day" -> "7d".  Unknown keys pass through. */
export function claudeWindowToken(key) {
  const match = /^([a-z]+)_(hour|day|week|month)s?/.exec(String(key));
  if (!match) return null;
  const count = WORD_NUMBERS[match[1]] ?? Number(match[1]);
  if (!Number.isFinite(count)) return null;
  return `${count}${UNIT_SUFFIX[match[2]]}`;
}

const CLAUDE_MODEL_SUFFIXES = ["opus", "sonnet", "haiku"];

function titleCaseModel(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Parse `GET https://api.anthropic.com/api/oauth/usage`.
 *
 * Shape: one object per window keyed by name — `five_hour`, `seven_day`, and
 * optional per-model windows like `seven_day_opus` — each carrying
 * `utilization` (percent USED, 0-100) and `resets_at`.  Windows arrive as
 * top-level keys, so iterate rather than naming them: Anthropic has added
 * per-model windows without notice.
 */
export function parseClaudeUsage(payload, { planType = null } = {}) {
  const root = asRecord(payload);
  const readings = [];
  for (const [key, rawWindow] of Object.entries(root)) {
    const windowRecord = asRecord(rawWindow);
    const utilization = firstNumber(windowRecord, [
      "utilization",
      "utilization_percent",
      "utilizationPercent",
      "used_percent",
      "usedPercent",
    ]);
    const remainingDirect = firstNumber(windowRecord, ["remaining_percent", "remainingPercent"]);
    if (utilization == null && remainingDirect == null) continue;

    let suffixModel = null;
    let baseKey = key;
    for (const suffix of CLAUDE_MODEL_SUFFIXES) {
      if (key.endsWith(`_${suffix}`)) {
        suffixModel = suffix;
        baseKey = key.slice(0, -(suffix.length + 1));
        break;
      }
    }
    const token = claudeWindowToken(baseKey) ?? claudeWindowToken(key) ?? baseKey;
    const used = utilization != null ? clampPercent(utilization) : null;
    const remaining =
      remainingDirect != null ? clampPercent(remainingDirect) : used == null ? null : 100 - used;

    readings.push(
      reading({
        bucketId: `anthropic:${key}`,
        label: suffixModel ? `${token} window (${titleCaseModel(suffixModel)})` : `${token} window`,
        quotaWindow: token,
        remainingPercent: remaining,
        usedPercent: used,
        resetAt: firstTimestamp(windowRecord, ["resets_at", "resetsAt", "reset_at", "resetAt"]),
        planType,
        modelId: suffixModel,
        remainingUnknown: remaining == null,
      }),
    );
  }
  return readings;
}

// ----------------------------------------------------------------- Codex ----

function codexWindowReading(windowRecord, { fallbackToken, slot, planType, nowMs }) {
  const record = asRecord(windowRecord);
  const used = firstNumber(record, [
    "used_percent",
    "usedPercent",
    "utilization",
    "percent_used",
  ]);
  const remainingDirect = firstNumber(record, ["remaining_percent", "remainingPercent"]);
  if (used == null && remainingDirect == null) return null;

  const seconds =
    firstNumber(record, ["limit_window_seconds", "limitWindowSeconds", "window_seconds"]) ??
    (firstNumber(record, ["window_minutes", "windowMinutes"]) ?? 0) * 60;
  const token = windowLabelFromSeconds(seconds) ?? fallbackToken;

  const resetAfter = firstNumber(record, [
    "reset_after_seconds",
    "resetAfterSeconds",
    "resets_in_seconds",
  ]);
  const resetAt =
    firstTimestamp(record, ["resets_at", "resetsAt", "reset_at", "resetAt"]) ??
    (resetAfter != null ? new Date(nowMs + resetAfter * 1000).toISOString() : null);

  const remaining = remainingDirect != null ? clampPercent(remainingDirect) : 100 - clampPercent(used);
  return reading({
    bucketId: `openai:${slot}`,
    label: `${token} window`,
    quotaWindow: token,
    remainingPercent: remaining,
    usedPercent: used != null ? clampPercent(used) : null,
    resetAt,
    planType,
    remainingUnknown: remaining == null,
  });
}

/**
 * Parse `GET https://chatgpt.com/backend-api/wham/usage`.
 *
 * Shape: `plan_type` plus `rate_limit.primary_window` / `.secondary_window`,
 * each with `used_percent`, `limit_window_seconds` and `reset_after_seconds`.
 * Primary is usually the 5h window and secondary the 7d, but the label is
 * derived from `limit_window_seconds` so a re-tuned window stays correct.
 */
export function parseCodexUsage(payload, { planType = null, now = Date.now() } = {}) {
  const root = asRecord(payload);
  const rateLimit = asRecord(root.rate_limit ?? root.rateLimit ?? root.rate_limits ?? root.limits);
  const plan = firstString(root, ["plan_type", "planType", "plan"]) ?? planType;
  const nowMs = typeof now === "number" ? now : Date.parse(String(now));

  const slots = [
    ["primary", rateLimit.primary_window ?? rateLimit.primaryWindow ?? rateLimit.primary, "5h"],
    [
      "secondary",
      rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? rateLimit.secondary,
      "weekly",
    ],
  ];
  const readings = [];
  for (const [slot, windowRecord, fallbackToken] of slots) {
    if (!windowRecord) continue;
    const parsed = codexWindowReading(windowRecord, {
      fallbackToken,
      slot,
      planType: plan,
      nowMs,
    });
    if (parsed) readings.push(parsed);
  }
  return readings;
}

// ------------------------------------------------------------------ Grok ----

/**
 * Parse `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`.
 *
 * The field names here are the least certain of the four, so accept every
 * plausible spelling and fall back to `used`/`limit` credit counts.  When
 * nothing matches, emit a `remainingUnknown` window rather than a wrong number:
 * a visibly unreported quota is honest, a fabricated 100% is not.
 */
export function parseGrokBilling(payload) {
  const root = asRecord(payload);
  const nested = asRecord(root.credits ?? root.usage ?? root.billing ?? root.data);
  const merged = { ...nested, ...root };

  const tier = firstString(merged, ["tier", "plan", "plan_type", "planType", "subscription"]);
  const resetAt = firstTimestamp(merged, [
    "resetAt",
    "reset_at",
    "nextResetAt",
    "next_reset_at",
    "resets_at",
    "resetsAt",
    "renewal_date",
    "period_end",
  ]);
  const windowSeconds = firstNumber(merged, [
    "limit_window_seconds",
    "limitWindowSeconds",
    "window_seconds",
  ]);
  const token =
    windowLabelFromSeconds(windowSeconds) ??
    firstString(merged, ["window", "period", "interval", "cadence"]) ??
    "weekly";

  const remainingDirect = firstNumber(merged, [
    "remainingPercent",
    "remaining_percent",
    "percentageRemaining",
    "percentage_remaining",
  ]);
  const usedDirect = firstNumber(merged, [
    "usedPercent",
    "used_percent",
    "percentage",
    "percentageUsed",
    "percentage_used",
    "utilization",
  ]);

  let remaining = remainingDirect;
  let used = usedDirect;
  if (remaining == null && used == null) {
    const usedCount = firstNumber(nested, ["used", "used_credits", "usedCredits"]) ??
      firstNumber(root, ["used", "used_credits", "usedCredits"]);
    const limitCount =
      firstNumber(nested, ["limit", "total", "quota", "limit_credits"]) ??
      firstNumber(root, ["limit", "total", "quota", "limit_credits"]);
    if (usedCount != null && limitCount != null && limitCount > 0) {
      used = (usedCount / limitCount) * 100;
      remaining = 100 - used;
    } else {
      // Some builds report only a raw `remaining` credit count with no limit.
      const remainingCount = firstNumber(merged, ["remaining", "remaining_credits"]);
      if (remainingCount != null && limitCount != null && limitCount > 0) {
        remaining = (remainingCount / limitCount) * 100;
        used = 100 - remaining;
      }
    }
  }
  if (remaining == null && used != null) remaining = 100 - used;

  return [
    reading({
      bucketId: `xai:${token}`,
      label: `${token} window`,
      quotaWindow: token,
      remainingPercent: remaining,
      usedPercent: used != null ? clampPercent(used) : null,
      resetAt,
      planType: tier,
      remainingUnknown: remaining == null,
    }),
  ];
}

// --------------------------------------------------------------- MiniMax ----

/**
 * Parse `GET /v1/api/openplatform/coding_plan/remains`.
 *
 * Shape: `base_resp.status_code` (0 = ok) plus `model_remains[]` rows carrying
 * `current_interval_usage_count` / `current_interval_total_count`.  Remaining
 * percent is (total - usage) / total.  With more than one model we also emit a
 * plan-wide row so the card can show one headline number.
 */
export function parseMinimaxRemains(payload) {
  const root = asRecord(payload);
  const baseResp = asRecord(root.base_resp ?? root.baseResp);
  const statusCode = firstNumber(baseResp, ["status_code", "statusCode"]);
  if (statusCode != null && statusCode !== 0) return [];

  const rows = Array.isArray(root.model_remains ?? root.modelRemains)
    ? root.model_remains ?? root.modelRemains
    : [];

  const readings = [];
  let totalUsed = 0;
  let totalLimit = 0;
  let planResetAt = null;

  for (const rawRow of rows) {
    const row = asRecord(rawRow);
    const modelName = firstString(row, ["model_name", "modelName", "model"]) ?? "model";
    const usage = firstNumber(row, [
      "current_interval_usage_count",
      "currentIntervalUsageCount",
      "usage_count",
    ]);
    const total = firstNumber(row, [
      "current_interval_total_count",
      "currentIntervalTotalCount",
      "total_count",
    ]);
    const resetAt = firstTimestamp(row, ["end_time", "endTime", "reset_time", "resetAt"]);
    if (resetAt && !planResetAt) planResetAt = resetAt;

    const windowSeconds = firstNumber(row, ["remains_time", "remainsTime"]);
    const startIso = firstTimestamp(row, ["start_time", "startTime"]);
    const token =
      startIso && resetAt
        ? windowLabelFromSeconds((Date.parse(resetAt) - Date.parse(startIso)) / 1000)
        : windowLabelFromSeconds(windowSeconds);

    const hasCounts = usage != null && total != null && total > 0;
    if (hasCounts) {
      totalUsed += usage;
      totalLimit += total;
    }
    const remaining = hasCounts ? ((total - usage) / total) * 100 : null;
    readings.push(
      reading({
        bucketId: `minimax:${modelName}`,
        label: `${modelName}${token ? ` (${token} window)` : ""}`,
        quotaWindow: token,
        remainingPercent: remaining,
        usedPercent: hasCounts ? clampPercent((usage / total) * 100) : null,
        resetAt,
        modelId: modelName,
        remainingUnknown: remaining == null,
      }),
    );
  }

  if (readings.length > 1 && totalLimit > 0) {
    const remaining = ((totalLimit - totalUsed) / totalLimit) * 100;
    readings.unshift(
      reading({
        bucketId: "minimax:coding-plan",
        label: "Coding plan (all models)",
        quotaWindow: readings[0].quotaWindow,
        remainingPercent: remaining,
        usedPercent: clampPercent((totalUsed / totalLimit) * 100),
        resetAt: planResetAt,
        remainingUnknown: false,
      }),
    );
  }

  return readings;
}

export const PROVIDER_PARSERS = {
  claude: parseClaudeUsage,
  codex: parseCodexUsage,
  grok: parseGrokBilling,
  minimax: parseMinimaxRemains,
};
