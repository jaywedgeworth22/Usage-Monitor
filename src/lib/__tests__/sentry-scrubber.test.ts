import type { EventHint } from "@sentry/core";
import { describe, expect, it } from "vitest";

import { sentryBeforeSend } from "../sentry-scrubber";

const NO_HINT: EventHint = {};

describe("sentryBeforeSend", () => {
  it("redacts keys whose names contain 'token', 'secret', 'key', 'password', 'passwd', or 'auth'", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: { headers: { authorization: "Bearer real-bearer-token" } },
        extra: {
          apiToken: "real-token-value",
          apiSecret: "real-secret-value",
          apiKey: "real-key-value",
          password: "real-password-value",
          passwd: "real-passwd-value",
          authHeader: "real-auth-value",
          benignValue: "kept-as-is",
        },
        tags: { region: "us-east-1" },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      extra: Record<string, unknown>;
      request: { headers: Record<string, unknown> };
      tags: Record<string, unknown>;
    };
    expect(typed.extra.apiToken).toBe("[REDACTED]");
    expect(typed.extra.apiSecret).toBe("[REDACTED]");
    expect(typed.extra.apiKey).toBe("[REDACTED]");
    expect(typed.extra.password).toBe("[REDACTED]");
    expect(typed.extra.passwd).toBe("[REDACTED]");
    expect(typed.extra.authHeader).toBe("[REDACTED]");
    expect(typed.extra.benignValue).toBe("kept-as-is");
    expect(typed.tags.region).toBe("us-east-1");
    expect(typed.request.headers.authorization).toBe("[REDACTED]");
  });

  it("preserves Sentry SDK-internal key names that look sensitive (public_key, etc.)", () => {
    // Codex review P2: Sentry's `dynamicSamplingContext.public_key` must
    // NOT be redacted or dynamic sampling breaks. Public keys are
    // non-secret identifiers required for trace correlation.
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        sdkProcessingMetadata: {
          dynamicSamplingContext: {
            public_key: "abc123-public-dsn-key",
            trace_id: "kept-trace-id",
          },
          requestSession: { status: "ok" },
        } as unknown as Record<string, unknown>,
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      sdkProcessingMetadata: {
        dynamicSamplingContext: { public_key: string; trace_id: string };
        requestSession: { status: string };
      };
    };
    expect(typed.sdkProcessingMetadata.dynamicSamplingContext.public_key).toBe(
      "abc123-public-dsn-key"
    );
    expect(typed.sdkProcessingMetadata.dynamicSamplingContext.trace_id).toBe("kept-trace-id");
    expect(typed.sdkProcessingMetadata.requestSession.status).toBe("ok");
  });

  it("redacts secrets embedded in URL query strings (Codex P1)", () => {
    // Codex review P1: `/api/bills.ics?token=...` puts the calendar token
    // in the request URL string, which lives under a non-sensitive key
    // (e.g. `request.url` or `transaction`). The key-name scrubber misses
    // it; the value-pattern scrubber must catch it.
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: {
          url: "https://usage.jays.services/api/bills.ics?token=real-calendar-token-here",
        },
        transaction: "/api/bills.ics?token=another-real-token",
        extra: { urlWithMultipleParams: "/api/x?safe=true&token=secret-value&page=1" },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      request: { url: string };
      transaction: string;
      extra: { urlWithMultipleParams: string };
    };
    expect(typed.request.url).toBe(
      "https://usage.jays.services/api/bills.ics?token=[REDACTED]"
    );
    expect(typed.transaction).toBe("/api/bills.ics?token=[REDACTED]");
    expect(typed.extra.urlWithMultipleParams).toBe("/api/x?safe=true&token=[REDACTED]&page=1");
    // Make sure the real secret value did not survive in any field.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("real-calendar-token-here");
    expect(serialized).not.toContain("another-real-token");
    expect(serialized).not.toContain("secret-value");
  });

  it("redacts bare query-string credentials without a leading ? (Codex re-review P1)", () => {
    // Codex re-review P1: Sentry's request normalizer stores
    // `request.query_string` as the substring after the leading `?`,
    // so `?token=abc` becomes `token=abc` (bare). The first regex
    // missed this; the new regex also matches start-of-string.
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: {
          url: "https://usage.jays.services/api/bills.ics?token=url-token",
          query_string: "token=query-string-token&page=2",
        },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as { request: { url: string; query_string: string } };
    expect(typed.request.url).toBe("https://usage.jays.services/api/bills.ics?token=[REDACTED]");
    expect(typed.request.query_string).toBe("token=[REDACTED]&page=2");
  });

  it("redacts common auth-shape URL params (api_key, access_token, refresh_token)", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: {
          url: "https://example.com/x?api_key=ak-real&access_token=at-real&refresh_token=rt-real",
        },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as { request: { url: string } };
    expect(typed.request.url).toBe(
      "https://example.com/x?api_key=[REDACTED]&access_token=[REDACTED]&refresh_token=[REDACTED]"
    );
  });

  it("scrubs Sentry SDK-internal cyclic metadata without recursing (Codex re-review P1)", () => {
    // Codex re-review P1: real transaction events carry a cyclic
    // `sdkProcessingMetadata.capturedSpanScope` AND
    // `capturedSpanIsolationScope` that both point to Sentry Scope
    // objects. Walking either would loop forever (or throw, bypassing
    // redaction). The scrubber must replace both with `[SDK_INTERNAL]`
    // without recursing.
    const cyclicScope: Record<string, unknown> = { type: "Scope" };
    cyclicScope.self = cyclicScope; // cycle
    const cyclicIsolationScope: Record<string, unknown> = { type: "IsolationScope" };
    cyclicIsolationScope.self = cyclicIsolationScope; // cycle
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        sdkProcessingMetadata: {
          capturedSpanScope: cyclicScope,
          capturedSpanIsolationScope: cyclicIsolationScope,
          requestSession: { status: "ok" },
        } as unknown as Record<string, unknown>,
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      sdkProcessingMetadata: {
        capturedSpanScope: string;
        capturedSpanIsolationScope: string;
        requestSession: { status: string };
      };
    };
    expect(typed.sdkProcessingMetadata.capturedSpanScope).toBe("[SDK_INTERNAL]");
    expect(typed.sdkProcessingMetadata.capturedSpanIsolationScope).toBe("[SDK_INTERNAL]");
    expect(typed.sdkProcessingMetadata.requestSession.status).toBe("ok");
  });

  it("recurses into nested objects and arrays", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        breadcrumbs: [
          { data: { token: "real" } },
          { message: "kept" },
        ],
        extra: { nested: { apiKey: "real", safe: { child: "kept" } } },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      breadcrumbs: Array<{ data?: { token?: string }; message?: string }>;
      extra: { nested: { apiKey: string; safe: { child: string } } };
    };
    expect(typed.breadcrumbs[0].data?.token).toBe("[REDACTED]");
    expect(typed.breadcrumbs[1].message).toBe("kept");
    expect(typed.extra.nested.apiKey).toBe("[REDACTED]");
    expect(typed.extra.nested.safe.child).toBe("kept");
  });

  it("returns the event unchanged when it is null, undefined, or a non-object", () => {
    expect(sentryBeforeSend(null as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)).toBe(
      null
    );
    expect(
      sentryBeforeSend(undefined as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)
    ).toBe(undefined);
    expect(
      sentryBeforeSend("string" as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)
    ).toBe("string");
    expect(
      sentryBeforeSend(42 as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)
    ).toBe(42);
  });

  it("does not throw when the input is malformed", () => {
    // Cyclic input is the realistic failure mode.
    const input: Record<string, unknown> = { extra: {} };
    input.extra = input; // cycle
    expect(() =>
      sentryBeforeSend(
        input as unknown as Parameters<typeof sentryBeforeSend>[0],
        NO_HINT
      )
    ).not.toThrow();
  });
});
