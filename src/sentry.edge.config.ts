// Edge-runtime twin of src/sentry.server.config.ts (middleware only). Same
// DSN gating: no SENTRY_DSN -> no init -> complete no-op.

import * as Sentry from "@sentry/nextjs";

import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";
import { sentryBeforeSend } from "@/lib/sentry-scrubber";

const dsn = nonEmptyEnv(process.env.SENTRY_DSN);

if (dsn) {
  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.SENTRY_ENVIRONMENT),
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    enableLogs: true,
    // Mirror the server config's defensive scrubber so middleware errors
    // never leak sensitive substring keys to Sentry either. See
    // src/lib/sentry-scrubber.ts. The `as unknown as` cast matches the
    // server config's note about @sentry/nextjs's nested @sentry/core copy.
    beforeSend: sentryBeforeSend as unknown as Parameters<typeof Sentry.init>[0]["beforeSend"],
  });
}
