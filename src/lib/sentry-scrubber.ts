/**
 * Sentry event scrubber for this app's server + edge configs.
 *
 * Audit finding 2026-09-20: `src/app/api/ingest/usage/route.ts` line 463 calls
 * `logIngestFailed({ reason: error.name, route })` from a catch-all; today the
 * Sentry `beforeSend` hook is absent, so any thrown object's `.message`,
 * `.metadata`, or `.extra` field is forwarded to Sentry as-is. The catch
 * block today is safe (it only sends `error.name`) but the absence of a
 * defensive scrubber means a future regression (a thrown Error carrying
 * `{ metadata: { token: 'real-secret' } }`, say) would leak to Sentry without
 * a guard rail.
 *
 * Contract: return `null` to drop the event, or the (possibly mutated) event
 * to keep it. We never throw from here.
 *
 * The substring list is intentionally narrow: it matches the words that
 * appear in any field name a producer could plausibly set on the v2 wire
 * (`token`, `secret`, `key`, `password`, `passwd`, `auth`). Real values are
 * not parsed - they are replaced with `"[REDACTED]"` only when they appear
 * inside an object key, not inside string values, to avoid scrubbing
 * legitimate token-shaped user data the dashboard is supposed to surface
 * (e.g. APNs device tokens in the dashboard's own alert routing UI).
 *
 * If a future producer starts sending legitimate values whose NAMES contain
 * those substrings, narrow this list or switch to a name-based redaction
 * map; do not delete the scrubber.
 */
import type { ErrorEvent, EventHint, TransactionEvent } from "@sentry/core";

const SENSITIVE_KEY_SUBSTRINGS = ["token", "secret", "key", "password", "passwd", "auth"];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function scrubObject<T>(input: T): T {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((entry) => scrubObject(entry)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = scrubObject(v);
    }
  }
  return out as T;
}

/**
 * `beforeSend` hook for Sentry.init()'s error path. Returns the event with
 * any object key whose name contains a sensitive substring replaced with
 * `"[REDACTED]"`, or `null` to drop the event. Never throws.
 */
export function sentryBeforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  try {
    if (!event || typeof event !== "object") return event;
    return scrubObject(event);
  } catch {
    // Defensive: a malformed event must not break Sentry's pipeline.
    return event;
  }
}

/**
 * `beforeSendTransaction` hook for Sentry.init()'s transaction path. Same
 * scrubber contract; transaction events have a different shape but the
 * key-name redaction logic is identical.
 */
export function sentryBeforeSendTransaction(
  event: TransactionEvent,
  _hint: EventHint
): TransactionEvent | null {
  try {
    if (!event || typeof event !== "object") return event;
    return scrubObject(event);
  } catch {
    return event;
  }
}
