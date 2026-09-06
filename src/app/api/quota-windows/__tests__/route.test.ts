import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      findMany: mocks.findMany,
    },
  },
}));

let GET: typeof import("../route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "native-read-token";

beforeAll(async () => {
  process.env.SESSION_SECRET = "quota-windows-route-test-secret";
  ({ GET } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([]);
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/quota-windows", {
    method: "GET",
    headers,
  });
}

describe("GET /api/quota-windows", () => {
  it("503s when no read token is configured", async () => {
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("accepts the dedicated read bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    mocks.findMany.mockResolvedValue([
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 0,
        limit: 100,
        occurredAt: new Date("2026-09-04T04:20:02.182Z"),
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: true },
      },
    ]);

    const response = await GET(request({ authorization: `Bearer ${READ_TOKEN}` }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipModelTypes).toEqual([
      { instanceId: "antigravity", model: "claude-opus-4-6-thinking" },
    ]);
    expect(response.headers.get("x-api-version")).toBe("1");
  });

  it("accepts a dashboard session", async () => {
    const response = await GET(
      request({
        cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledOnce();
  });
});
