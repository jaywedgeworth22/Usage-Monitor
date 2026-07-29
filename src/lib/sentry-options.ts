// Shared, dependency-free options for the app's OWN Sentry SDK init
// (review finding O4: self error-reporting, off by default).
//
// Kept separate from the sentry.server/edge/client config files so all three
// runtimes parse env vars identically. Everything here is a pure function on
// strings — safe to import from the client (browser) bundle as well.

/**
 * Parses SENTRY_TRACES_SAMPLE_RATE (or its NEXT_PUBLIC_ client twin).
 * Defaults to 0 (error monitoring only, no performance tracing) so enabling
 * the DSN alone never generates tracing volume. Non-numeric, negative, or
 * missing values all fall back to 0; values above 1 are clamped to 1.
 */
export function parseTracesSampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1);
}

/** Trims an env var to a non-empty value, else undefined. */
export function nonEmptyEnv(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
