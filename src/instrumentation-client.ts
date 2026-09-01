// Browser-side self error-reporting (review finding O4). Next.js picks this
// file up automatically (it replaces the old sentry.client.config convention).
//
// Browser env vars must be NEXT_PUBLIC_* to be inlined at build time, so the
// client is gated on NEXT_PUBLIC_SENTRY_DSN independently of the server-side
// SENTRY_DSN. Unset -> no init -> complete no-op (CI/dev need nothing).

import * as Sentry from "@sentry/nextjs";

import { startDatadogRum } from "@/lib/datadog-rum-client";
import { resolveDatadogRumConfig } from "@/lib/datadog-options";
import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";

// Build-time RUM (same NEXT_PUBLIC_* bake as Sentry).  Incomplete public
// keys stay dark — do not throw from this module or Next.js white-screens
// login.  Runtime Infisical tokens are picked up by DatadogRumInit.
try {
  const rum = resolveDatadogRumConfig();
  if (rum.enabled) {
    startDatadogRum(rum);
  }
} catch (error) {
  console.error(
    "[datadog] incomplete RUM config; skipping client init",
    error
  );
}

const dsn = nonEmptyEnv(process.env.NEXT_PUBLIC_SENTRY_DSN);

if (dsn) {
  const replayDisabled = process.env.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED === "false";
  const replaySessionSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0.1"
  );
  const replayErrorSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "1.0"
  );

  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT),
    tracesSampleRate: parseTracesSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    ),
    replaysSessionSampleRate: !replayDisabled ? replaySessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled ? replayErrorSampleRate : 0,
    integrations: !replayDisabled
      ? [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })]
      : [],
  });
}

// Instruments client-side router navigations. Harmless when init never ran
// (Sentry no-ops without a client).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

