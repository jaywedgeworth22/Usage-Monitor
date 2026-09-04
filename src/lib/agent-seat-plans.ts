import { normalizeMonthlyUsd, type SubscriptionInterval } from "@/lib/subscriptions";

/**
 * Fleet coding-seat list prices shown on /agents.
 *
 * These are consumer subscription SKUs (Claude Max, ChatGPT Pro, SuperGrok
 * Heavy), not API prepaid.  Hardcoded Pro $20 / SuperGrok $30 defaults made
 * the dashboard claim the owner was on the cheap tier.  Owner correction
 * 2026-09-03: Claude Max 20x $200, SuperGrok Heavy $300 list (promo billed
 * $100 for one more month), ChatGPT Pro $200 for the Codex CLI window we
 * backfill.  Active Subscription rows may raise billed/list; they must not
 * pull a Max/Heavy seat back down to a leftover Pro $20 / SuperGrok $30 row.
 */

export type AgentPlatformId =
  | "claude-code"
  | "openai-codex"
  | "cursor-agent"
  | "grok-build"
  | "antigravity-cli"
  | "github-copilot";

export interface AgentSeatCatalogEntry {
  planName: string;
  listMonthlyUsd: number;
  /** Cash billed this month when a promo differs from list. */
  billedMonthlyUsd?: number;
  billedNote?: string;
}

export interface AgentSeatSubscriptionInput {
  status: string;
  name: string;
  costUsd: number;
  currency?: string | null;
  interval: string;
  intervalCount: number;
  providerName: string;
  providerDisplayName: string;
}

export interface ResolvedAgentSeat {
  planName: string;
  listMonthlyUsd: number;
  billedMonthlyUsd: number;
  source: "catalog" | "subscription";
  note: string | null;
}

export const AGENT_SEAT_CATALOG: Record<AgentPlatformId, AgentSeatCatalogEntry> = {
  "claude-code": {
    planName: "Claude Max 20x",
    listMonthlyUsd: 200,
  },
  "openai-codex": {
    planName: "ChatGPT Pro",
    listMonthlyUsd: 200,
  },
  "cursor-agent": {
    planName: "Cursor Pro",
    listMonthlyUsd: 20,
  },
  "grok-build": {
    planName: "SuperGrok Heavy",
    listMonthlyUsd: 300,
    billedMonthlyUsd: 100,
    billedNote: "Promo billed $100 for one more month.  List price is $300.",
  },
  "antigravity-cli": {
    planName: "Antigravity",
    listMonthlyUsd: 20,
  },
  "github-copilot": {
    planName: "GitHub Copilot",
    listMonthlyUsd: 19,
  },
};

const PLATFORM_MATCHERS: Record<AgentPlatformId, (haystack: string) => boolean> = {
  "claude-code": (h) => /\banthropic\b|\bclaude\b/.test(h),
  "openai-codex": (h) =>
    /\bcodex\b|\bchatgpt\b/.test(h) ||
    (/\bopenai\b/.test(h) && /\b(plus|pro|team|enterprise)\b/.test(h)),
  "cursor-agent": (h) => /\bcursor\b/.test(h),
  "grok-build": (h) =>
    /\bsupergrok\b/.test(h) ||
    (/\bgrok\b/.test(h) && !/\bapi\b/.test(h)) ||
    (/\bxai\b/.test(h) && /\b(super|heavy|plus|premium)\b/.test(h)),
  "antigravity-cli": (h) => /\bantigravity\b/.test(h),
  "github-copilot": (h) => /\bcopilot\b/.test(h),
};

export function isAgentPlatformId(value: string): value is AgentPlatformId {
  return Object.prototype.hasOwnProperty.call(AGENT_SEAT_CATALOG, value);
}

function haystackFor(sub: AgentSeatSubscriptionInput): string {
  return `${sub.providerName} ${sub.providerDisplayName} ${sub.name}`.toLowerCase();
}

function monthlyFromSub(sub: AgentSeatSubscriptionInput): number | null {
  if (sub.status.trim().toLowerCase() !== "active") return null;
  if ((sub.currency ?? "USD").trim().toUpperCase() !== "USD") return null;
  if (!Number.isFinite(sub.costUsd) || sub.costUsd <= 0) return null;
  const interval = sub.interval.trim().toLowerCase();
  if (
    interval !== "weekly" &&
    interval !== "monthly" &&
    interval !== "quarterly" &&
    interval !== "annual"
  ) {
    return null;
  }
  const monthly = normalizeMonthlyUsd(
    sub.costUsd,
    interval as SubscriptionInterval,
    sub.intervalCount
  );
  return Number.isFinite(monthly) && monthly > 0 ? monthly : null;
}

/**
 * Catalog list/billed first.  An active matching subscription may raise the
 * billed or list amount.  A leftover cheap-tier row (Pro $20, SuperGrok $30)
 * cannot understate a Max/Heavy catalog seat.
 */
export function resolveAgentSeat(
  platformId: AgentPlatformId,
  subscriptions: readonly AgentSeatSubscriptionInput[]
): ResolvedAgentSeat {
  const catalog = AGENT_SEAT_CATALOG[platformId];
  const list = catalog.listMonthlyUsd;
  const catalogBilled = catalog.billedMonthlyUsd ?? list;
  const matcher = PLATFORM_MATCHERS[platformId];

  let bestMonthly = 0;
  let bestName: string | null = null;
  for (const sub of subscriptions) {
    const monthly = monthlyFromSub(sub);
    if (monthly == null) continue;
    if (!matcher(haystackFor(sub))) continue;
    if (monthly > bestMonthly) {
      bestMonthly = monthly;
      bestName = sub.name.trim() || null;
    }
  }

  const raiseFloor = catalogBilled * 0.8;
  if (bestMonthly + 1e-9 >= raiseFloor) {
    const nextList = Math.max(list, bestMonthly);
    const nextBilled = Math.max(catalogBilled, bestMonthly);
    return {
      planName: bestName || catalog.planName,
      listMonthlyUsd: nextList,
      billedMonthlyUsd: nextBilled >= nextList ? nextList : bestMonthly,
      source: "subscription",
      note:
        nextBilled + 0.5 < nextList
          ? catalog.billedNote ??
            `Promo billed $${Math.round(bestMonthly)} this month.  List price is $${Math.round(nextList)}.`
          : null,
    };
  }

  return {
    planName: catalog.planName,
    listMonthlyUsd: list,
    billedMonthlyUsd: catalogBilled,
    source: "catalog",
    note: catalogBilled + 0.5 < list ? catalog.billedNote ?? null : null,
  };
}
