/**
 * Subscription-seat analytics telemetry is an API-equivalent estimate, never
 * cash. Claude Code OTLP already lands this way; Codex JSONL and Grok Build
 * session logs join the same bucket once the Mac collectors ingest them.
 *
 * Keep the Claude discriminator exact so Anthropic API usage (a different
 * sourceApp) still bills as cash. New seats match on sourceApp only.
 */

export const SUBSCRIPTION_ANALYTICS_SOURCE_APPS = [
  "claude-code",
  "grok-build",
  "openai-codex",
  "antigravity-cli",
] as const;

export type SubscriptionAnalyticsSourceApp =
  (typeof SUBSCRIPTION_ANALYTICS_SOURCE_APPS)[number];

/** sourceApp-only seats. Claude Code stays exact (sourceApp AND service)
 *  because `sourceApp=claude-code` without `service=claude-code` is used for
 *  other Anthropic telemetry that must remain cash. */
const SOURCE_APP_ONLY_ANALYTICS = new Set<string>([
  "grok-build",
  "openai-codex",
  "antigravity-cli",
]);

export function isClaudeCodeAnalyticsTelemetry(input: {
  sourceApp: string;
  service?: string | null;
}): boolean {
  return (
    input.sourceApp?.trim().toLowerCase() === "claude-code" &&
    input.service?.trim().toLowerCase() === "claude-code"
  );
}

export function isSubscriptionAnalyticsTelemetry(input: {
  sourceApp: string;
  service?: string | null;
}): boolean {
  if (isClaudeCodeAnalyticsTelemetry(input)) return true;
  const app = input.sourceApp?.trim().toLowerCase();
  return Boolean(app && SOURCE_APP_ONLY_ANALYTICS.has(app));
}

/** Token derivation fill-in: Claude already stores OTLP costUsd as the
 * estimate, so adding tokens x price would double-count. Other seats post
 * tokens (and optional vendor ticks) and need the catalog estimate. */
export function shouldDeriveAnalyticsTokenEstimate(input: {
  sourceApp: string;
  service?: string | null;
}): boolean {
  if (isClaudeCodeAnalyticsTelemetry(input)) return false;
  return isSubscriptionAnalyticsTelemetry(input);
}
