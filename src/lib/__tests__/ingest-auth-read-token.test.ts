import { describe, expect, it } from "vitest";
import {
  getUsageReadTokenReadiness,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";

describe("resolveUsageReadToken (C10)", () => {
  it("prefers USAGE_READ_TOKEN when set", () => {
    expect(
      resolveUsageReadToken({
        USAGE_READ_TOKEN: "read-secret",
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toBe("read-secret");
  });

  it("denies ingest fallback in production by default", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toBeUndefined();
  });

  it("allows ingest fallback outside production", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toBe("ingest-secret");
  });

  it("allows explicit production fallback opt-in", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
        USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK: "true",
      } as NodeJS.ProcessEnv)
    ).toBe("ingest-secret");
  });
});

describe("getUsageReadTokenReadiness", () => {
  it("flags a fully configured production deployment", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_READ_TOKEN: "read-secret",
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: true,
      dedicated: true,
      breakGlassFallback: false,
      readsAuthorized: true,
    });
  });

  it("flags the production misconfiguration monitors must alert on", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: true,
      dedicated: false,
      breakGlassFallback: false,
      readsAuthorized: false,
    });
  });

  it("treats break-glass fallback as authorized but not dedicated", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
        USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK: "true",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: true,
      dedicated: false,
      breakGlassFallback: true,
      readsAuthorized: true,
    });
  });

  it("is not required outside production, where the fallback is allowed", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: false,
      dedicated: false,
      breakGlassFallback: false,
      readsAuthorized: true,
    });
  });

  it("reports unauthorized when no token resolves at all", () => {
    expect(
      getUsageReadTokenReadiness({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: false,
      dedicated: false,
      breakGlassFallback: false,
      readsAuthorized: false,
    });
  });
});
