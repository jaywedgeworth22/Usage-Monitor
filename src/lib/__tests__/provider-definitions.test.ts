import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROVIDERS,
  hasConfiguredProviderField,
} from "@/lib/provider-definitions";

describe("hasConfiguredProviderField", () => {
  it("accepts an existing protected value while editing without exposing or resending it", () => {
    expect(hasConfiguredProviderField({}, "secretKey", ["secretKey"])).toBe(true);
    expect(hasConfiguredProviderField({}, "apiSecret", ["apiSecret"])).toBe(true);
  });

  it("still requires a value for a new or unconfigured provider", () => {
    expect(hasConfiguredProviderField({}, "secretKey")).toBe(false);
    expect(hasConfiguredProviderField({ secretKey: "  " }, "secretKey")).toBe(false);
    expect(hasConfiguredProviderField({ secretKey: "configured" }, "secretKey")).toBe(true);
  });
});

describe("Cloudflare provider definition", () => {
  it("requires the account ID but does not imply an email for API-token auth", () => {
    const cloudflare = BUILT_IN_PROVIDERS.find(
      (provider) => provider.name === "cloudflare"
    );

    expect(cloudflare?.needsAccountId).toBe(true);
    expect(cloudflare?.helpNote).toMatch(/Billing Read API token needs no email/i);
    expect(cloudflare?.helpNote).toMatch(/email is only for a Global API key/i);
    expect(cloudflare?.helpNote).toMatch(
      /single-resource metadata\/readability probes only/i
    );
    expect(cloudflare?.helpNote).toMatch(
      /do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility/i
    );
  });
});

describe("Anthropic provider definition", () => {
  it("does not imply individual accounts can obtain direct billing access", () => {
    const anthropic = BUILT_IN_PROVIDERS.find(
      (provider) => provider.name === "anthropic"
    );
    const adminField = anthropic?.needsConfig?.fields.find(
      (field) => field.key === "adminApiKey"
    );

    expect(anthropic?.helpNote).toMatch(/individual accounts cannot use/i);
    expect(anthropic?.helpNote).toMatch(/no standard Messages API key is requested/i);
    expect(anthropic?.helpNote).toMatch(/pushed per-request telemetry/i);
    expect(anthropic?.helpNote).toMatch(/Subscription or receipt reconciliation/i);
    expect(anthropic?.usesApiKey).toBe(false);
    expect(adminField?.label).toMatch(/organization accounts only/i);
    expect(adminField?.advanced).toBe(true);
  });
});
