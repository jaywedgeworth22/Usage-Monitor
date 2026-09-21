// Edge-runtime twin of src/sentry.server.config.ts (middleware only). Same
// DSN gating: no SENTRY_DSN -> no init -> complete no-op.

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
    // Mirror the server config's defensive scrubber for both error and
    // transaction paths. The middleware can emit sampled request
    // transactions (e.g. /api/bills.ics?token=...) and those go through
    // beforeSendTransaction, not beforeSend — installing only the error
    // hook would let transaction URLs leak unsanitized. See
    // src/lib/sentry-scrubber.ts. The `as unknown as` cast matches the
    // server config's note about @sentry/nextjs's nested @sentry/core copy.
    beforeSend: sentryBeforeSend as unknown as Parameters<typeof Sentry.init>[0]["beforeSend"],
    beforeSendTransaction:
      sentryBeforeSendTransaction as unknown as Parameters<typeof Sentry.init>[0]["beforeSendTransaction"],
  });
}
