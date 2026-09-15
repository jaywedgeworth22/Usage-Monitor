// Shared builder for `metricType: "quota"` remaining-percent events.
//
// The Antigravity collector (scripts/fleet-usage-collector.mjs and
// scripts/antigravity-usage-collector.mjs) has emitted this shape since
// 2026-08: `credits` is the percent REMAINING, `limit` is always 100, and the
// reset time / window label / model live in `metadata`.  The read path
// (src/lib/quota-windows.ts `projectQuotaWindows`) derives
// `remainingPercent = credits / limit` from exactly those fields.
//
// Every subscription-quota provider must therefore emit the same shape, or the
// dashboard silently drops it.  This module is that one definition.

/** A provider-neutral description of one subscription quota window. */
/**
 * @typedef {object} QuotaWindowReading
 * @property {string} bucketId      Stable id for this window within the provider.
 * @property {string} label         Human label, sentence case, e.g. "5h window".
 * @property {string|null} quotaWindow  Short window token, e.g. "5h", "7d", "weekly".
 * @property {number|null} remainingPercent  0-100, or null when not reported.
 * @property {number|null} usedPercent       0-100, or null when not reported.
 * @property {string|null} resetAt  ISO-8601 instant the window refreshes.
 * @property {string|null} planType Subscription plan name, when the provider states it.
 * @property {string|null} modelId  Model this window is scoped to, when applicable.
 * @property {boolean} remainingUnknown
 * @property {boolean} isExhausted
 */

/** Clamp to a sane 0-100 percentage, or null when the input is not a number. */
export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

/**
 * Normalise a timestamp to ISO-8601.  Accepts an ISO string, epoch seconds, or
 * epoch milliseconds.  Returns null for anything it cannot read, never throws.
 */
export function toIsoTimestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds vs milliseconds: 1e12 ms is 2001, 1e12 s is year 33658.
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return toIsoTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * Derive a short window token from a window length in seconds.  Providers
 * report the length rather than a name, and the names drift, so never hard-code
 * "primary = 5h": read the seconds.
 */
export function windowLabelFromSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const hours = n / 3600;
  if (hours < 1.5) return "1h";
  if (hours <= 12) return `${Math.round(hours)}h`;
  if (hours <= 30) return "daily";
  if (hours <= 24 * 8) return "weekly";
  if (hours <= 24 * 32) return "monthly";
  return `${Math.round(hours / 24)}d`;
}

/**
 * Build the ExternalUsageEvent for one window reading.
 *
 * `eventId` is keyed on the reset instant so repeated 15-minute ticks inside
 * one window collapse to a single row rather than one row per tick, matching
 * `agy-quota:<bucket>:<reset_time>`.  When the provider reports no reset time
 * we fall back to the current hour so the series still advances.
 */
export function buildQuotaEvent({
  provider,
  service,
  reading,
  source,
  occurredAtIso = new Date().toISOString(),
}) {
  const remaining = reading.remainingUnknown ? null : clampPercent(reading.remainingPercent);
  const used =
    reading.usedPercent != null
      ? clampPercent(reading.usedPercent)
      : remaining == null
        ? null
        : Math.round((100 - remaining) * 100) / 100;
  const seriesKey = reading.resetAt ?? `${occurredAtIso.slice(0, 13)}:00`;
  return {
    eventId: `subq:${provider}:${reading.bucketId}:${seriesKey}`,
    provider,
    service,
    label: reading.label,
    metricType: "quota",
    billingMode: "actual",
    confidence: "actual",
    limit: 100,
    // `credits` must be a NUMBER in the shared v2 contract, so an unreported
    // window omits the field entirely rather than sending null; the read path
    // already treats a missing `credits` as "not reported".
    ...(remaining == null ? {} : { credits: remaining }),
    // NOT `limitWindow`: the shared v2 contract restricts that to
    // minute|day|month|run, and a "5h"/"weekly" value fails the whole batch
    // server-side with nothing visible on the dashboard.  The window token
    // lives in metadata.quotaWindow, which is what projectQuotaWindows reads.
    occurredAt: occurredAtIso,
    metadata: {
      bucketId: reading.bucketId,
      quotaWindow: reading.quotaWindow,
      resetAt: reading.resetAt,
      planType: reading.planType,
      modelId: reading.modelId,
      usedPercent: used,
      isExhausted: Boolean(reading.isExhausted),
      remainingUnknown: Boolean(reading.remainingUnknown),
      scale: "percent_0_100",
      source,
    },
  };
}
