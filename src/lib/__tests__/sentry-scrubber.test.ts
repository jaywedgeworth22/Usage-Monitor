import type { EventHint } from "@sentry/core";
import { describe, expect, it } from "vitest";

import { sentryBeforeSend } from "../sentry-scrubber";

const NO_HINT: EventHint = {};

describe("sentryBeforeSend", () => {
  it("redacts keys whose names contain 'token', 'secret', 'key', 'password', 'passwd', or 'auth'", () => {
    const result = sentryBeforeSend(
      {
        // Cast keeps the test free of the ErrorEvent literal-type tax; the
        // scrubber only reads object keys, so the literal value is irrelevant.
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
    const typed = result as {
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
