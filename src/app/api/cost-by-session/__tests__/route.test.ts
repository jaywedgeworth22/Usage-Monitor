import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CostBySessionRow } from "@/lib/cost-by-session";

const mocks = vi.hoisted(() => ({
  loadCostBySessionRows: vi.fn<(ids: string[], since: Date, until: Date) => Promise<CostBySessionRow[]>>(),
}));

vi.mock("@/lib/cost-by-session", async () => {
  // Keep the real pure functions (parseSessionIdsParam, buildCostBySessionReport,
  // the exported constants) so the route is exercised end-to-end apart from the
  // DB call -- only loadCostBySessionRows touches Prisma/$queryRaw.
  const actual = await vi.importActual<typeof import("@/lib/cost-by-session")>("@/lib/cost-by-session");
  return { ...actual, loadCostBySessionRows: mocks.loadCostBySessionRows };
});

import { GET } from "../route";

function request(query: string): NextRequest {
  return new NextRequest(`https://usage.jays.services/api/cost-by-session${query}`);
}

function row(overrides: Partial<CostBySessionRow> = {}): CostBySessionRow {
  return {
    sessionId: "session-a",
    metricType: "cost",
    unit: null,
    model: "claude-sonnet-5",
    label: "estimated_api_equivalent",
    quantity: 0,
    costUsd: 1.5,
    eventCount: 3,
    firstOccurredAt: new Date("2026-09-20T00:00:00Z"),
    lastOccurredAt: new Date("2026-09-24T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.loadCostBySessionRows.mockReset();
  mocks.loadCostBySessionRows.mockResolvedValue([]);
});

describe("GET /api/cost-by-session", () => {
  it("400s when ids is missing", async () => {
    const response = await GET(request(""));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("ids_required");
    expect(mocks.loadCostBySessionRows).not.toHaveBeenCalled();
  });

  it("400s on a malformed since/until date", async () => {
    const response = await GET(request("?ids=session-a&since=not-a-date"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_since");
  });

  it("400s when since is after until", async () => {
    const response = await GET(
      request("?ids=session-a&since=2026-09-24T00:00:00Z&until=2026-09-01T00:00:00Z")
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("since_after_until");
  });

  it("400s when the requested window exceeds MAX_WINDOW_DAYS", async () => {
    const response = await GET(
      request("?ids=session-a&since=2020-01-01T00:00:00Z&until=2026-09-24T00:00:00Z")
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("window_too_large");
  });

  it("passes parsed ids and the resolved window through to loadCostBySessionRows", async () => {
    mocks.loadCostBySessionRows.mockResolvedValue([row()]);
    const response = await GET(
      request("?ids=session-a,session-b&since=2026-09-20T00:00:00Z&until=2026-09-24T00:00:00Z")
    );
    expect(response.status).toBe(200);
    expect(mocks.loadCostBySessionRows).toHaveBeenCalledTimes(1);
    const [ids, since, until] = mocks.loadCostBySessionRows.mock.calls[0];
    expect(ids).toEqual(["session-a", "session-b"]);
    expect(since.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-09-24T00:00:00.000Z");

    const body = await response.json();
    expect(body.matchedSessionIds).toEqual(["session-a"]);
    expect(body.unmatchedSessionIds).toEqual(["session-b"]);
    expect(body.totals.costUsd).toBeCloseTo(1.5);
    expect(body.window).toEqual({ since: "2026-09-20T00:00:00.000Z", until: "2026-09-24T00:00:00.000Z" });
    expect(body.billingMode).toBe("estimated");
  });

  it("defaults the window to the trailing DEFAULT_WINDOW_DAYS when since/until are omitted", async () => {
    const { DEFAULT_WINDOW_DAYS } = await import("@/lib/cost-by-session");
    await GET(request("?ids=session-a"));
    const [, since, until] = mocks.loadCostBySessionRows.mock.calls[0];
    const spanDays = (until.getTime() - since.getTime()) / 86_400_000;
    expect(spanDays).toBeCloseTo(DEFAULT_WINDOW_DAYS, 5);
  });
});
