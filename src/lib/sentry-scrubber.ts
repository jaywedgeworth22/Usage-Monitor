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
 * Two-phase scrub:
 *   1. Key-name redaction — any object key whose name contains a sensitive
 *      substring is replaced with `"[REDACTED]"`. Names that look sensitive
 *      but are actually SDK internals (Sentry's `public_key` in
 *      `dynamicSamplingContext`, for example) are allow-listed.
 *   2. Value-pattern redaction — string values are scanned for URL query
 *      strings like `?token=...&secret=...` and replaced. The redaction
 *      applies to the parameter value, not the whole string.
 *
 * Contract: return `null` to drop the event, or the (possibly mutated) event
 * to keep it. We never throw from here.
 */
import type { ErrorEvent, EventHint, TransactionEvent } from "@sentry/core";

// Key-name substrings that always trigger redaction. Lowercased.
const SENSITIVE_KEY_SUBSTRINGS = ["token", "secret", "key", "password", "passwd", "auth"];

// Key-name substrings that LOOK sensitive but are SDK/protocol internals and
// must be preserved. Each entry is matched against the lowercase key name.
const SENSITIVE_BUT_SAFE_KEY_SUBSTRINGS = ["public_key", "publickey", "sessionkey"];

// Regex for URL query-string redaction. Matches `?name=value&name=value`
// patterns; we replace the value, not the whole URL. Patterns are case-
// insensitive on the parameter name only.
const URL_QUERY_REDACTION_REGEX =
  /([?&])(token|secret|password|passwd|auth|api_key|apikey|access_token|refresh_token)(=)([^&\s"']*)/gi;

function isSafeKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_BUT_SAFE_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function isSensitiveKey(key: string): boolean {
  if (isSafeKey(key)) return false;
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function redactUrlQueryStrings(value: string): string {
  return value.replace(URL_QUERY_REDACTION_REGEX, (_match, prefix, _name, eq, _value) => {
    return `${prefix}${_name}${eq}[REDACTED]`;
  });
}

function scrubString(value: string): string {
  // Pattern 1: redact `name=value` URL query strings. This is the high-
  // confidence path — parameter names are explicitly listed and the match
  // is anchored to the parameter name, not the value.
  return redactUrlQueryStrings(value);
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
    } else if (typeof v === "string") {
      // Pattern 2: redact URL query-string parameters in string values,
      // even when the host key (e.g. `url`, `query_string`) is not itself
      // sensitive. Catches `request.url` carrying `/api/bills.ics?token=...`.
      out[k] = scrubString(v);
    } else {
      out[k] = scrubObject(v);
    }
  }
  return out as T;
}

/**
 * `beforeSend` hook for Sentry.init()'s error path. Returns the event with
 * any sensitive object key replaced with `"[REDACTED]"`, plus URL query-
 * string parameters with sensitive names redacted. Never throws.
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
