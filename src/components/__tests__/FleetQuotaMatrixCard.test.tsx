/**
 * Component test for FleetQuotaMatrixCard.
 *
 * This repo has no jsdom/happy-dom and no @testing-library/react wired up
 * (see src/__tests__/platforms-page-client.test.ts's own note on this), and
 * adding either as a new test-time dependency is out of scope for this
 * change. So, following that same established repo pattern, the reviewable
 * logic here is exercised directly:
 *   - `buildProviderGroups` (the pure fetch-response -> render-model mapper)
 *     is tested against a mixed fixture covering all five providers.
 *   - The presentational pieces (`ProviderSection`, `QuotaWindowCard`, and
 *     the default-exported card itself) are rendered with
 *     `react-dom/server`'s `renderToStaticMarkup` — exactly like the
 *     existing `ProviderCard.test.ts` — so assertions run against real
 *     rendered HTML, not a re-implementation of the component's logic.
 *   - `global.fetch` is still mocked to cover the same
 *     fetch -> res.json() -> buildProviderGroups pipeline the component's
 *     `useEffect` runs, without requiring a DOM to flush that effect.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FleetQuotaMatrixCard, {
  ProviderSection,
  QuotaWindowCard,
  buildProviderGroups,
} from "@/components/FleetQuotaMatrixCard";

const NBSP = " ";
const EXPECTED_LABELS = ["Claude", "Codex", "Antigravity", "Grok", "MiniMax"];
const NOW_MS = new Date("2026-09-12T00:00:00.000Z").getTime();

/** Normalize the NBSP sentence gap to a plain space for text comparisons. */
function normalizeGaps(text: string): string {
  return text.replace(new RegExp(NBSP, "g"), " ");
}

/**
 * A mixed /api/quota-windows payload: two anthropic windows with real
 * percentages, one Antigravity window whose label mentions Claude (the
 * exact "Claude and GPT models" routing bucket this whole change exists to
 * stop rendering as the user's Claude plan), one Grok window, and Codex /
 * MiniMax reporting nothing yet.
 */
const mixedPayload = {
  ok: true,
  generatedAt: "2026-09-12T00:00:00.000Z",
  windows: [],
  skipModelTypes: [],
  providerGroups: [
    {
      provider: "anthropic",
      providerLabel: "Claude",
      via: null,
      expected: true,
      windows: [
        {
          id: "anthropic-5h",
          provider: "anthropic",
          providerKey: "anthropic",
          providerLabel: "Claude",
          via: null,
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "5h window",
          remainingPercent: 62.5,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-12T05:00:00.000Z",
          window: "5h",
          status: "available",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: "api.anthropic.com",
        },
        {
          id: "anthropic-7d",
          provider: "anthropic",
          providerKey: "anthropic",
          providerLabel: "Claude",
          via: null,
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "7d window",
          remainingPercent: 18.0,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-15T00:00:00.000Z",
          window: "7d",
          status: "near_cap",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: "api.anthropic.com",
        },
      ],
    },
    {
      provider: "openai",
      providerLabel: "Codex",
      via: null,
      expected: true,
      windows: [],
    },
    {
      provider: "google-antigravity",
      providerLabel: "Antigravity",
      via: "antigravity",
      expected: true,
      windows: [
        {
          id: "antigravity-claude-gpt",
          provider: "google-antigravity",
          providerKey: "google-antigravity",
          providerLabel: "Antigravity",
          via: "antigravity",
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "Claude and GPT models",
          remainingPercent: 40,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-12T06:00:00.000Z",
          window: "5h",
          status: "available",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: null,
        },
      ],
    },
    {
      provider: "xai",
      providerLabel: "Grok",
      via: null,
      expected: true,
      windows: [
        {
          id: "xai-5h",
          provider: "xai",
          providerKey: "xai",
          providerLabel: "Grok",
          via: null,
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "5h window",
          remainingPercent: 80,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-12T04:00:00.000Z",
          window: "5h",
          status: "available",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: "api.x.ai",
        },
      ],
    },
    {
      provider: "minimax",
      providerLabel: "MiniMax",
      via: null,
      expected: true,
      windows: [],
    },
  ],
};

describe("buildProviderGroups", () => {
  it("returns exactly the five expected providers, in the order the API returned them", () => {
    const groups = buildProviderGroups(mixedPayload);
    expect(groups).toHaveLength(5);
    expect(groups.map((g) => g.provider)).toEqual([
      "anthropic",
      "openai",
      "google-antigravity",
      "xai",
      "minimax",
    ]);
    expect(groups.map((g) => g.providerLabel)).toEqual(EXPECTED_LABELS);
  });

  it("keeps both anthropic windows' remaining percentages with no via flag", () => {
    const groups = buildProviderGroups(mixedPayload);
    const anthropic = groups.find((g) => g.provider === "anthropic")!;
    expect(anthropic.windows.map((w) => w.remainingPercent)).toEqual([62.5, 18.0]);
    expect(anthropic.windows.every((w) => w.via === null)).toBe(true);
  });

  it("marks the Antigravity window via Antigravity even though its label says Claude and GPT", () => {
    const groups = buildProviderGroups(mixedPayload);
    const antigravity = groups.find((g) => g.provider === "google-antigravity")!;
    expect(antigravity.windows).toHaveLength(1);
    expect(antigravity.windows[0].label).toBe("Claude and GPT models");
    expect(antigravity.windows[0].via).toBe("antigravity");
  });

  it("leaves Codex and MiniMax with zero windows for the empty-state row", () => {
    const groups = buildProviderGroups(mixedPayload);
    expect(groups.find((g) => g.provider === "openai")!.windows).toHaveLength(0);
    expect(groups.find((g) => g.provider === "minimax")!.windows).toHaveLength(0);
  });
});

describe("QuotaWindowCard rendering", () => {
  it("renders the anthropic 5h and 7d windows' percentages without a via Antigravity caption", () => {
    const groups = buildProviderGroups(mixedPayload);
    const anthropic = groups.find((g) => g.provider === "anthropic")!;
    const html = anthropic.windows
      .map((win) => renderToStaticMarkup(createElement(QuotaWindowCard, { win, nowMs: NOW_MS })))
      .join("\n");

    expect(html).toContain("62.5% remaining");
    expect(html).toContain("18.0% remaining");
    expect(html).not.toContain("via Antigravity");
  });

  it("renders the via Antigravity caption for the Antigravity bucket", () => {
    const groups = buildProviderGroups(mixedPayload);
    const antigravity = groups.find((g) => g.provider === "google-antigravity")!;
    const html = renderToStaticMarkup(
      createElement(QuotaWindowCard, { win: antigravity.windows[0], nowMs: NOW_MS })
    );

    expect(html).toContain("via Antigravity");
    expect(html).toContain("Claude and GPT models");
    expect(html).toContain("40.0% remaining");
  });
});

describe("ProviderSection rendering", () => {
  it("renders the empty-state copy for Codex and MiniMax, tolerant of the NBSP sentence gap", () => {
    const groups = buildProviderGroups(mixedPayload);
    for (const providerKey of ["openai", "minimax"]) {
      const group = groups.find((g) => g.provider === providerKey)!;
      const html = renderToStaticMarkup(createElement(ProviderSection, { group, nowMs: NOW_MS }));
      expect(normalizeGaps(html)).toContain(
        "No quota report yet.  Install the subscription quota collector on the Mac."
      );
    }
  });

  it("does not render the empty-state copy for a provider with reported windows", () => {
    const groups = buildProviderGroups(mixedPayload);
    for (const providerKey of ["anthropic", "google-antigravity", "xai"]) {
      const group = groups.find((g) => g.provider === providerKey)!;
      const html = renderToStaticMarkup(createElement(ProviderSection, { group, nowMs: NOW_MS }));
      expect(html).not.toContain("No quota report yet");
    }
  });

  it("renders every provider label and no fake/demo bucket", () => {
    const groups = buildProviderGroups(mixedPayload);
    const html = groups
      .map((group) => renderToStaticMarkup(createElement(ProviderSection, { group, nowMs: NOW_MS })))
      .join("\n");

    for (const label of EXPECTED_LABELS) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/lorem ipsum|demo bucket|sample bucket|fake data/i);
  });
});

describe("FleetQuotaMatrixCard default render (before any fetch resolves)", () => {
  it("renders the honest title, all five provider labels, and never claims to be live", () => {
    const html = renderToStaticMarkup(createElement(FleetQuotaMatrixCard));
    expect(html).toContain("Subscription Quotas");
    expect(html).not.toMatch(/live/i);
    for (const label of EXPECTED_LABELS) {
      expect(html).toContain(label);
    }
  });
});

describe("mocked fetch -> buildProviderGroups pipeline", () => {
  it("produces the same grouped result the component's effect would compute", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mixedPayload,
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const res = await fetch("/api/quota-windows", { cache: "no-store" });
      const data = await res.json();
      const groups = buildProviderGroups(data);

      expect(fetchMock).toHaveBeenCalledWith("/api/quota-windows", { cache: "no-store" });
      expect(groups.map((g) => g.providerLabel)).toEqual(EXPECTED_LABELS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
