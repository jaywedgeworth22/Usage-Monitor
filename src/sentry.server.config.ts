// Self error-reporting for THIS app (review finding O4). Imported lazily from
// src/instrumentation.ts register() when NEXT_RUNTIME === "nodejs".
//
// DSN-gated by design: with SENTRY_DSN unset the SDK is never initialized and
// this module is a complete no-op, so CI/dev/production builds and boots never
// require any Sentry configuration. Never hardcode a DSN here.

import * as Sentry from "@sentry/nextjs";

import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";
import { sentryBeforeSend, sentryBeforeSendTransaction } from "@/lib/sentry-scrubber";

const dsn = nonEmptyEnv(process.env.SENTRY_DSN);

if (dsn) {
  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.SENTRY_ENVIRONMENT),
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    enableLogs: true,
    profileSessionSampleRate: parseTracesSampleRate(
      process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? "1"
    ),
    profileLifecycle: "trace",
    // Audit 2026-09-20: any object key whose name contains a sensitive
    // substring (token/secret/key/password/passwd/auth) is replaced with
    // "[REDACTED]" before the event is sent. Defensive guard against
    // future regressions where a thrown Error carries a payload with
    // secret-shaped metadata. See src/lib/sentry-scrubber.ts.
    // The cast is necessary because @sentry/nextjs re-bundles its own copy of
    // @sentry/core whose `TransactionEvent` is structurally identical but
    // nominally distinct from the one imported inside the scrubber.
    beforeSend: sentryBeforeSend as unknown as Parameters<typeof Sentry.init>[0]["beforeSend"],
    beforeSendTransaction:
      sentryBeforeSendTransaction as unknown as Parameters<typeof Sentry.init>[0]["beforeSendTransaction"],
    integrations: [Sentry.nodeRuntimeMetricsIntegration()],
  });
}
