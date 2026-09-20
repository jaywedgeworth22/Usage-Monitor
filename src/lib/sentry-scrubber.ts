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
 * Three-phase scrub:
 *   1. Key-name redaction — any object key whose name contains a sensitive
 *      substring is replaced with `"[REDACTED]"`. Names that look sensitive
 *      but are actually SDK internals (Sentry's `public_key` in
 *      `dynamicSamplingContext`, for example) are allow-listed.
 *   2. Value-pattern redaction — string values are scanned for URL query
 *      strings like `?token=...` and `&token=...` and replaced. The
 *      redaction applies to the parameter value, not the whole string.
 *      Bare `key=value` (no leading `?`) is also matched because Sentry's
 *      request normalizer stores `request.query_string` without the `?`.
 *   3. SDK-internal field skip — certain cyclic metadata fields
 *      (`capturedSpanScope`, etc.) are scrubbed by identity (`===`) on the
 *      key path, not by recursion, so we never walk into Sentry's cyclic
 *      Scope objects and throw out of the catch handler (which would
 *      bypass all redaction).
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

// Regex for URL query-string redaction. Matches three cases:
//   - `?name=value` (URL with query string)
//   - `&name=value` (subsequent params)
//   - `^name=value` (bare query string with no `?`, as Sentry stores
//     `request.query_string` after slicing the leading `?`)
const URL_QUERY_REDACTION_REGEX =
  /([?&]|^)(token|secret|password|passwd|auth|api_key|apikey|access_token|refresh_token)(=)([^&\s"']*)/gi;

// Key paths to scrub by identity (replace with `[REDACTED]`) instead of
// recursing into them. These are Sentry SDK-owned cyclic metadata fields
// that would otherwise throw our recursion. Each entry is the dotted
// path from the event root to the field. Match is case-sensitive.
//
// Sentry 10.74 ships BOTH `capturedSpanScope` AND `capturedSpanIsolationScope`
// on sampled server transactions; both point to cyclic `Scope` objects and
// must be skipped together (Codex re-review P1, observed 2026-09-20 on
// commit 5c17318).
const SDK_INTERNAL_CYCLIC_PATHS = new Set([
  "sdkProcessingMetadata.capturedSpanScope",
  "sdkProcessingMetadata.capturedSpanIsolationScope",
  "sdkProcessingMetadata.capturedSpanScopeAsString",
]);

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
  return value.replace(URL_QUERY_REDACTION_REGEX, (_match, prefix, _name, eq) => {
    return `${prefix}${_name}${eq}[REDACTED]`;
  });
}

function scrubString(value: string): string {
  return redactUrlQueryStrings(value);
}

function scrubObject<T>(input: T, keyPath: string = ""): T {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((entry, idx) => scrubObject(entry, `${keyPath}[${idx}]`)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const childPath = keyPath ? `${keyPath}.${k}` : k;
    if (SDK_INTERNAL_CYCLIC_PATHS.has(childPath)) {
      // Skip recursion into Sentry SDK-internal cyclic metadata. Replace
      // with a placeholder so the field survives but doesn't carry a
      // sensitive payload up to the root.
      out[k] = "[SDK_INTERNAL]";
      continue;
    }
    if (isSensitiveKey(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "string") {
      out[k] = scrubString(v);
    } else {
      out[k] = scrubObject(v, childPath);
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
