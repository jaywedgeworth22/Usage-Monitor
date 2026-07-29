// Self error-reporting for THIS app (review finding O4). Imported lazily from
// src/instrumentation.ts register() when NEXT_RUNTIME === "nodejs".
//
// DSN-gated by design: with SENTRY_DSN unset the SDK is never initialized and
// this module is a complete no-op, so CI/dev/production builds and boots never
// require any Sentry configuration. Never hardcode a DSN here.

import * as Sentry from "@sentry/nextjs";

import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";

const dsn = nonEmptyEnv(process.env.SENTRY_DSN);

if (dsn) {
  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.SENTRY_ENVIRONMENT),
    // Default 0: errors only, no performance tracing volume unless opted in.
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
  });
}
