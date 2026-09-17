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
  // Admin-only app: Replay is ON unless NEXT_PUBLIC_SENTRY_REPLAY_ENABLED is
  // an explicit falsy ("false"/"0"/"off"/"no").  Defaults: 100% on error,
  // 10% of sessions (within the 5–10% band).  Keep maskAllText/blockAllMedia.
  // Do not copy Socratic.Trade's opt-in flag here.
  const replayRaw = process.env.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED?.trim();
  const replayDisabled = replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false;
  const replaySessionSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0.1"
  );
  const replayErrorSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "1.0"
  );
  const feedbackRaw = process.env.NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED?.trim();
  const feedbackDisabled = feedbackRaw ? /^(false|0|off|no)$/i.test(feedbackRaw) : false;

  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT),
    tracesSampleRate: parseTracesSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    ),
    enableLogs: true,
    replaysSessionSampleRate: !replayDisabled ? replaySessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled ? replayErrorSampleRate : 0,
    integrations: [
      ...(!replayDisabled
        ? [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })]
        : []),
      ...(!feedbackDisabled
        ? [
            Sentry.feedbackIntegration({
              colorScheme: "light",
              autoInject: false,
              showBranding: false,
              buttonLabel: "Report a Problem",
              submitButtonLabel: "Send",
              formTitle: "Report a Problem",
            }),
          ]
        : []),
    ],
  });
}

/** Open the Sentry user feedback dialog.  Returns false when Feedback is dark. */
export function openSentryFeedback(): boolean {
  try {
    const SentryWithFeedback = Sentry as unknown as { getFeedback?: () => { createForm?: () => Promise<{ appendToDom: () => void; open: () => void }> } };
    const feedback = SentryWithFeedback.getFeedback?.();
    if (feedback?.createForm) {
      void feedback.createForm().then((form) => {
        form.appendToDom();
        form.open();
      }).catch(() => {});
      return true;
    }

    if (typeof window !== "undefined") {
      const windowFeedback = (window as unknown as { Sentry?: { getFeedback?: () => { createForm?: () => Promise<{ appendToDom: () => void; open: () => void }> } } }).Sentry?.getFeedback?.();
      if (windowFeedback?.createForm) {
        void windowFeedback.createForm().then((form) => {
          form.appendToDom();
          form.open();
        }).catch(() => {});
        return true;
      }
    }
  } catch {
    // Safe no-op if feedback is not initialized or fails
  }
  return false;
}

if (typeof window !== "undefined") {
  (window as unknown as { openSentryFeedback?: typeof openSentryFeedback }).openSentryFeedback = openSentryFeedback;
}

// Instruments client-side router navigations. Harmless when init never ran
// (Sentry no-ops without a client).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

