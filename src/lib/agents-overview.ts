import {
  AGENT_SEAT_CATALOG,
  isAgentPlatformId,
  resolveAgentSeat,
  type AgentSeatSubscriptionInput,
} from "@/lib/agent-seat-plans";
import { getExternalEventRawCutoff, startOfUtcDay } from "@/lib/data-retention";
import { getLatestMacHealth } from "@/lib/mac-health";
import { prisma } from "@/lib/prisma";
import { deriveTokenCostUsd, getModelPricing } from "@/lib/pricing/model-pricing";
import { SUBSCRIPTION_ANALYTICS_SOURCE_APPS } from "@/lib/subscription-analytics";
import {
  isReliableTokenTelemetryKind,
  resolveTelemetryAccuracy,
  telemetryIncompleteNoteFor,
  type TelemetryAccuracy,
  type TokenTelemetryKind,
} from "@/lib/agent-telemetry-accuracy";

export interface AgentPlatformMeta {
  id: string;
  name: string;
  provider: string;
  description: string;
  dataCapability: string;
  fidelityTier: "realtime_otlp" | "session_jsonl" | "process_only" | "unavailable";
  tokenTelemetryKind: TokenTelemetryKind;
  notes: string;
  defaultMonthlySeatCostUsd: number;
  listMonthlySeatCostUsd?: number;
  bundledOffsetUsd?: number;
  bundledOffsetLabel?: string;
  unavailableReason?: string;
}

export const AGENT_PLATFORMS: readonly AgentPlatformMeta[] = [
  {
    id: "claude-code",
    name: "Claude Code / Desktop",
    provider: "Anthropic",
    description: "Claude Code CLI, Claude Desktop, and Monet multi-agent sync.",
    dataCapability: "Full real-time OTLP telemetry (/api/otlp/v1/metrics)",
    fidelityTier: "realtime_otlp",
    tokenTelemetryKind: "otlp",
    notes: "Native OTLP metrics stream reports per-turn tokens (input, output, cache-read, cache-creation) and cost estimates directly from Claude processes.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["claude-code"].listMonthlyUsd,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    provider: "OpenAI",
    description: "Codex CLI & autonomous coding cloud agent.",
    dataCapability: "Incremental session JSONL delta parsing",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes: "Ingests token usage snapshots from ~/.codex/sessions/**/*.jsonl. Deduplicates consecutive token_count replays automatically.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["openai-codex"].listMonthlyUsd,
  },
  {
    id: "cursor-agent",
    name: "Cursor",
    provider: "Cursor",
    description: "Cursor AI editor & background agent process.",
    dataCapability: "Live process detection. Token telemetry is not available.",
    fidelityTier: "process_only",
    tokenTelemetryKind: "none",
    notes: "Cursor keeps usage local to its IDE client and does not expose an unauthenticated local token ledger.  Process status is live.  Usage is not reported.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["cursor-agent"].listMonthlyUsd,
    unavailableReason:
      "Cursor does not expose a local token ledger.  Process status is live.  Usage is not reported.",
  },
  {
    id: "grok-build",
    name: "Grok Build & Leader",
    provider: "xAI",
    description: "Grok CLI, Grok Leader PM2 service, and Grok ACP agent.",
    dataCapability: "Turn-completed token & costUsdTicks parsing",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes: "Ingests turn_completed events from ~/.grok/sessions/**/updates.jsonl with model breakdown and high-precision cost ticks.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["grok-build"].listMonthlyUsd,
  },
  {
    id: "antigravity-cli",
    name: "Antigravity",
    provider: "Google",
    description: "Antigravity pair-programming agent & agy-acp PM2 service.",
    dataCapability: "Quota windows from agy /usage only. Token telemetry is not available.",
    fidelityTier: "unavailable",
    tokenTelemetryKind: "character_estimate",
    notes:
      "Google Antigravity does not expose token telemetry.  Local transcript character estimates are not usage and must not be read as burn.  Seat is $100/mo Google AI Ultra; $30 of that was already Google One, so $70 net for the AI.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["antigravity-cli"].billedMonthlyUsd ?? 70,
    listMonthlySeatCostUsd: AGENT_SEAT_CATALOG["antigravity-cli"].listMonthlyUsd,
    bundledOffsetUsd: 30,
    bundledOffsetLabel: "Google One",
    unavailableReason:
      "Antigravity does not expose token telemetry.  Local transcript character estimates are not usage.  This is not zero use.",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    provider: "GitHub",
    description: "GitHub Copilot CLI & IDE assistant.",
    dataCapability: "Session shutdown modelMetrics delta parsing",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes: "Ingests session.shutdown modelMetrics from ~/.copilot/session-state/ with inclusive cache token splitting.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["github-copilot"].listMonthlyUsd,
  },
];

const TOKEN_TELEMETRY_KIND_BY_APP = new Map(
  AGENT_PLATFORMS.map((meta) => [meta.id, meta.tokenTelemetryKind] as const),
);

export function isReliableTokenSourceApp(sourceApp: string): boolean {
  const kind = TOKEN_TELEMETRY_KIND_BY_APP.get(sourceApp.trim().toLowerCase());
  if (!kind) return true;
  return isReliableTokenTelemetryKind(kind);
}

export interface AgentPlatformStatus {
  id: string;
  name: string;
  provider: string;
  isRunningOnMac: boolean;
  macStatus: "running" | "idle" | "stopped" | "unknown";
  dataCapability: string;
  fidelityTier: "realtime_otlp" | "session_jsonl" | "process_only" | "unavailable";
  notes: string;
  monthlySeatCostUsd: number;
  billedMonthlySeatCostUsd: number;
  seatPlanName: string;
  seatPlanNote: string | null;
  seatPlanSource: "catalog" | "subscription";
  listMonthlySeatCostUsd: number;
  bundledOffsetUsd: number | null;
  bundledOffsetLabel: string | null;
  seatCostNote: string | null;
  telemetryAccuracy: TelemetryAccuracy;
  telemetryAccuracyLabel: string;
  telemetryAccuracyNote: string;
  usageIsReliable: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiEquivalentCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  netSavingsUsd: number;
  modelsUsed: Array<{
    model: string;
    tokens: number;
    percentOfPlatform: number;
    apiEquivalentCostUsd: number;
  }>;
}

export interface AgentsOverviewResponse {
  ok: boolean;
  windowDays: number;
  windowLabel: string;
  generatedAt: string;
  macHostname: string;
  macChip: string;
  summary: {
    activeAgentCount: number;
    totalAgentCount: number;
    totalTokens: number;
    totalApiEquivalentCostUsd: number;
    totalSubscriptionCostUsd: number;
    totalNetSavingsUsd: number;
    savingsMultiplier: number;
    topModel: string | null;
    telemetryIncomplete: boolean;
    telemetryIncompleteNote: string | null;
    unreliablePlatformIds: string[];
  };
  burn5h: {
    tokens5h: number;
    costEstimate5hUsd: number;
    burnRateTokensPerHour: number;
    burnRateUsdPerHour: number;
  };
  platforms: AgentPlatformStatus[];
  modelDistribution: Array<{
    model: string;
    provider: string;
    tokens: number;
    percent: number;
    apiEquivalentCostUsd: number;
  }>;
}

export async function computeAgentsOverview(windowDays: number = 30): Promise<AgentsOverviewResponse> {
  const now = new Date();
  const since = windowDays >= 3650 ? new Date(0) : new Date(now.getTime() - windowDays * 86_400_000);
  const windowLabel =
    windowDays <= 1
      ? "Last 24 Hours"
      : windowDays <= 7
      ? "Last 7 Days"
      : windowDays <= 30
      ? "Last 30 Days"
      : "All Time";

  const window5hStart = new Date(now.getTime() - 5 * 3_600_000);
  const otherSeats = SUBSCRIPTION_ANALYTICS_SOURCE_APPS.filter(
    (app) => app !== "claude-code"
  );
  const seatsFilter = [...otherSeats, "cursor-agent"];

  const eventWhereOr = [
    { sourceApp: "claude-code", service: "claude-code" },
    { sourceApp: { in: seatsFilter } },
  ];

  // Same split as summarizeExternalUsageEvents: raw events from the retention
  // cutoff forward, daily rollups only for days before that cutoff.  Adding
  // both for the same days double-counted tokens after a collector backfill.
  const rawCutoff = getExternalEventRawCutoff(now);
  const rawSince = since > rawCutoff ? since : rawCutoff;
  const queryRollups = since < rawCutoff;
  const rollupDayGte = startOfUtcDay(since);

  const emptyRollup = Promise.resolve(
    [] as Array<{
      sourceApp: string;
      provider: string;
      keyRef: string | null;
      label?: string | null;
      _sum: { totalQuantity?: number | null; totalCostUsd?: number | null };
    }>
  );

  const [
    macHealth,
    tokenGroups,
    costGroups,
    token5hGroups,
    cost5hGroups,
    rollupTokenGroups,
    rollupCostGroups,
    earliestEvent,
    subscriptionRows,
  ] = await Promise.all([
    getLatestMacHealth().catch(() => null),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef", "label"],
      where: {
        OR: eventWhereOr,
        metricType: "usage",
        unit: "token",
        occurredAt: { gte: rawSince },
      },
      _sum: { quantity: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef"],
      where: {
        OR: eventWhereOr,
        metricType: "cost",
        occurredAt: { gte: rawSince },
      },
      _sum: { costUsd: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef", "label"],
      where: {
        OR: eventWhereOr,
        metricType: "usage",
        unit: "token",
        occurredAt: { gte: window5hStart },
      },
      _sum: { quantity: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef"],
      where: {
        OR: eventWhereOr,
        metricType: "cost",
        occurredAt: { gte: window5hStart },
      },
      _sum: { costUsd: true },
    }),
    queryRollups
      ? prisma.externalUsageEventDailyRollup.groupBy({
          by: ["sourceApp", "provider", "keyRef", "label"],
          where: {
            OR: eventWhereOr,
            metricType: "usage",
            unit: "token",
            day: { gte: rollupDayGte, lt: rawCutoff },
          },
          _sum: { totalQuantity: true },
        })
      : emptyRollup,
    queryRollups
      ? prisma.externalUsageEventDailyRollup.groupBy({
          by: ["sourceApp", "provider", "keyRef"],
          where: {
            OR: eventWhereOr,
            metricType: "cost",
            day: { gte: rollupDayGte, lt: rawCutoff },
          },
          _sum: { totalCostUsd: true },
        })
      : emptyRollup,
    windowDays > 30
      ? prisma.externalUsageEvent.findFirst({
          where: { OR: eventWhereOr },
          orderBy: { occurredAt: "asc" },
          select: { occurredAt: true },
        })
      : null,
    prisma.subscription.findMany({
      where: { currency: "USD" },
      select: {
        status: true,
        name: true,
        costUsd: true,
        currency: true,
        interval: true,
        intervalCount: true,
        provider: { select: { name: true, displayName: true } },
      },
    }),
  ]);

  const seatSubscriptions: AgentSeatSubscriptionInput[] = subscriptionRows.map((row) => ({
    status: row.status,
    name: row.name,
    costUsd: row.costUsd,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.intervalCount,
    providerName: row.provider.name,
    providerDisplayName: row.provider.displayName,
  }));

  const agentProcesses = macHealth?.mac?.agentProcesses || {};
  const macProcesses = macHealth?.mac?.processes || {};

  // Build model token breakdowns
  type TokenBreakdown = {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    unknown: number;
    total: number;
  };

  const tokensByPlatformAndModel = new Map<string, Map<string, TokenBreakdown>>();
  const reportedCostByPlatform = new Map<string, number>();

  for (const row of costGroups) {
    if (!isReliableTokenSourceApp(row.sourceApp)) continue;
    const app = row.sourceApp.toLowerCase();
    const current = reportedCostByPlatform.get(app) || 0;
    reportedCostByPlatform.set(app, current + (row._sum.costUsd || 0));
  }
  for (const row of rollupCostGroups) {
    if (!isReliableTokenSourceApp(row.sourceApp)) continue;
    const app = row.sourceApp.toLowerCase();
    const current = reportedCostByPlatform.get(app) || 0;
    reportedCostByPlatform.set(app, current + (row._sum.totalCostUsd || 0));
  }

  let grandTotalTokens = 0;
  const tokensByModel = new Map<string, { provider: string; tokens: number; apiCost: number }>();

  const allTokenRows = [
    ...tokenGroups.map((g) => ({
      sourceApp: g.sourceApp,
      provider: g.provider,
      keyRef: g.keyRef,
      label: g.label,
      quantity: g._sum.quantity,
    })),
    ...rollupTokenGroups.map((g) => ({
      sourceApp: g.sourceApp,
      provider: g.provider,
      keyRef: g.keyRef,
      label: g.label,
      quantity: g._sum.totalQuantity,
    })),
  ];

  for (const group of allTokenRows) {
    if (!isReliableTokenSourceApp(group.sourceApp)) continue;
    const app = group.sourceApp.toLowerCase();
    const model = group.keyRef || "unknown-model";
    const qty = Math.max(0, group.quantity || 0);
    grandTotalTokens += qty;

    if (!tokensByPlatformAndModel.has(app)) {
      tokensByPlatformAndModel.set(app, new Map());
    }
    const modelMap = tokensByPlatformAndModel.get(app)!;
    if (!modelMap.has(model)) {
      modelMap.set(model, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unknown: 0, total: 0 });
    }
    const breakdown = modelMap.get(model)!;
    breakdown.total += qty;

    const label = group.label?.toLowerCase() || "";
    if (label.includes("input")) {
      breakdown.input += qty;
    } else if (label.includes("output")) {
      breakdown.output += qty;
    } else if (label.includes("cacheread") || label.includes("cache_read") || label.includes("cache_hit")) {
      breakdown.cacheRead += qty;
    } else if (label.includes("cachecreation") || label.includes("cache_creation") || label.includes("cache_write")) {
      breakdown.cacheCreation += qty;
    } else {
      breakdown.unknown += qty;
    }

    // Model distribution
    const existingModel = tokensByModel.get(model) || { provider: group.provider, tokens: 0, apiCost: 0 };
    existingModel.tokens += qty;
    tokensByModel.set(model, existingModel);
  }

  // Calculate API-equivalent pricing per platform & model
  let totalApiEquivalentCost = 0;
  let totalSubscriptionCost = 0;
  let activeAgentCount = 0;

  let effectiveDays = windowDays;
  if (windowDays >= 3650) {
    if (earliestEvent?.occurredAt) {
      const elapsedDays = Math.ceil(
        (now.getTime() - earliestEvent.occurredAt.getTime()) / 86_400_000
      );
      effectiveDays = Math.max(30, elapsedDays);
    } else {
      effectiveDays = 30;
    }
  }

  const platforms: AgentPlatformStatus[] = AGENT_PLATFORMS.map((meta) => {
    const appKey = meta.id.toLowerCase();
    const isRunning =
      agentProcesses[appKey] === "running" ||
      (appKey === "grok-build" && (macProcesses["grok-leader"] === "running" || agentProcesses["grok-build"] === "running")) ||
      (appKey === "claude-code" && (macProcesses["claude-remote-control"] === "running" || agentProcesses["claude-code"] === "running"));

    if (isRunning) activeAgentCount++;

    const modelMap = tokensByPlatformAndModel.get(appKey) || new Map();
    let platformTotalTokens = 0;
    let platformInput = 0;
    let platformOutput = 0;
    let platformCacheRead = 0;
    let platformCacheCreation = 0;
    let platformApiCost = 0;

    const modelsUsed: AgentPlatformStatus["modelsUsed"] = [];

    for (const [modelName, breakdown] of modelMap.entries()) {
      platformTotalTokens += breakdown.total;
      platformInput += breakdown.input;
      platformOutput += breakdown.output;
      platformCacheRead += breakdown.cacheRead;
      platformCacheCreation += breakdown.cacheCreation;

      // Price the model tokens
      const modelPricing = getModelPricing(modelName);
      const priced = modelPricing
        ? deriveTokenCostUsd(modelPricing.pricing, {
            input: breakdown.input + breakdown.unknown,
            output: breakdown.output,
            cacheRead: breakdown.cacheRead,
            cacheCreation: breakdown.cacheCreation,
          })
        : null;

      const modelCost = priced?.costUsd || 0;
      platformApiCost += modelCost;

      modelsUsed.push({
        model: modelName,
        tokens: breakdown.total,
        percentOfPlatform: 0, // computed below
        apiEquivalentCostUsd: Number(modelCost.toFixed(4)),
      });

      // Add to overall model distribution
      const globalModel = tokensByModel.get(modelName);
      if (globalModel) {
        globalModel.apiCost += modelCost;
      }
    }

    // Compute model percentage of platform
    for (const item of modelsUsed) {
      item.percentOfPlatform = platformTotalTokens > 0 ? (item.tokens / platformTotalTokens) * 100 : 0;
    }
    modelsUsed.sort((a, b) => b.tokens - a.tokens);

    const reportedCost = reportedCostByPlatform.get(appKey) || 0;
    const estimatedCost = Math.max(platformApiCost, reportedCost);
    const seat = isAgentPlatformId(meta.id)
      ? resolveAgentSeat(meta.id, seatSubscriptions)
      : {
          planName: `${meta.name} seat`,
          listMonthlyUsd: meta.listMonthlySeatCostUsd ?? meta.defaultMonthlySeatCostUsd,
          billedMonthlyUsd: meta.defaultMonthlySeatCostUsd,
          source: "catalog" as const,
          note: null,
        };
    const bundledOffset = meta.bundledOffsetUsd ?? null;
    const bundledOffsetLabel = meta.bundledOffsetLabel ?? null;
    const listSeat = Math.max(seat.listMonthlyUsd, meta.listMonthlySeatCostUsd ?? 0);
    const billedSeat = seat.billedMonthlyUsd;
    const monthlySeat =
      bundledOffset != null && bundledOffset > 0 ? billedSeat : listSeat;
    const seatCostNote =
      bundledOffset != null && bundledOffset > 0
        ? `$${listSeat}/mo plan.  $${bundledOffset} of that was already ${bundledOffsetLabel ?? "bundled"}, so $${monthlySeat} net for the AI.`
        : seat.note;
    const proratedSubscriptionCost =
      (billedSeat / 30) * Math.min(windowDays, effectiveDays);

    const accuracy = resolveTelemetryAccuracy({
      name: meta.name,
      tokenTelemetryKind: meta.tokenTelemetryKind,
      totalTokens: platformTotalTokens,
      isRunningOnMac: Boolean(isRunning),
      unavailableReason: meta.unavailableReason,
    });

    const displayTokens = accuracy.usageIsReliable ? platformTotalTokens : 0;
    const displayApiCost = accuracy.usageIsReliable ? platformApiCost : 0;
    const displayReported = accuracy.usageIsReliable ? reportedCost : 0;
    const displayEstimated = accuracy.usageIsReliable ? estimatedCost : 0;
    const netSavings = Math.max(0, displayEstimated - proratedSubscriptionCost);

    totalApiEquivalentCost += displayEstimated;
    totalSubscriptionCost += proratedSubscriptionCost;

    return {
      id: meta.id,
      name: meta.name,
      provider: meta.provider,
      isRunningOnMac: Boolean(isRunning),
      macStatus: isRunning ? "running" : "idle",
      dataCapability: meta.dataCapability,
      fidelityTier: meta.fidelityTier,
      notes: meta.notes,
      monthlySeatCostUsd: monthlySeat,
      billedMonthlySeatCostUsd: billedSeat,
      seatPlanName: seat.planName,
      seatPlanNote: seat.note,
      seatPlanSource: seat.source,
      listMonthlySeatCostUsd: listSeat,
      bundledOffsetUsd: bundledOffset,
      bundledOffsetLabel,
      seatCostNote,
      telemetryAccuracy: accuracy.accuracy,
      telemetryAccuracyLabel: accuracy.label,
      telemetryAccuracyNote: accuracy.note,
      usageIsReliable: accuracy.usageIsReliable,
      totalTokens: displayTokens,
      inputTokens: accuracy.usageIsReliable ? platformInput : 0,
      outputTokens: accuracy.usageIsReliable ? platformOutput : 0,
      cacheReadTokens: accuracy.usageIsReliable ? platformCacheRead : 0,
      cacheCreationTokens: accuracy.usageIsReliable ? platformCacheCreation : 0,
      apiEquivalentCostUsd: Number(displayApiCost.toFixed(2)),
      reportedCostUsd: Number(displayReported.toFixed(2)),
      estimatedCostUsd: Number(displayEstimated.toFixed(2)),
      netSavingsUsd: Number(netSavings.toFixed(2)),
      modelsUsed: accuracy.usageIsReliable ? modelsUsed : [],
    };
  });

  const modelDistribution = Array.from(tokensByModel.entries())
    .map(([model, data]) => ({
      model,
      provider: data.provider,
      tokens: data.tokens,
      percent: grandTotalTokens > 0 ? (data.tokens / grandTotalTokens) * 100 : 0,
      apiEquivalentCostUsd: Number(data.apiCost.toFixed(2)),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const topModel = modelDistribution[0]?.model || null;
  const totalNetSavings = Math.max(0, totalApiEquivalentCost - totalSubscriptionCost);
  const savingsMultiplier = totalSubscriptionCost > 0 ? totalApiEquivalentCost / totalSubscriptionCost : 1;
  const unreliablePlatforms = platforms.filter((p) => !p.usageIsReliable);
  const telemetryIncompleteNote = telemetryIncompleteNoteFor(
    unreliablePlatforms.map((p) => p.name),
  );

  // 5-hour rolling burn numbers
  let tokens5h = 0;
  let derivedCost5hUsd = 0;
  let reportedCost5hUsd = 0;

  for (const g of token5hGroups) {
    if (!isReliableTokenSourceApp(g.sourceApp)) continue;
    const qty = Math.max(0, g._sum.quantity || 0);
    tokens5h += qty;
    const model = g.keyRef || "";
    const modelPricing = getModelPricing(model);
    const priced = modelPricing
      ? deriveTokenCostUsd(modelPricing.pricing, { input: qty })
      : null;
    derivedCost5hUsd += priced?.costUsd || 0;
  }

  for (const g of cost5hGroups) {
    if (!isReliableTokenSourceApp(g.sourceApp)) continue;
    const cost = Math.max(0, g._sum.costUsd || 0);
    reportedCost5hUsd += cost;
  }

  const costEstimate5hUsd = Math.max(derivedCost5hUsd, reportedCost5hUsd);
  const burnRateTokensPerHour = Math.round(tokens5h / 5);
  const burnRateUsdPerHour = Number((costEstimate5hUsd / 5).toFixed(2));

  return {
    ok: true,
    windowDays,
    windowLabel,
    generatedAt: now.toISOString(),
    macHostname: macHealth?.mac?.hostname || "jays.services",
    macChip: macHealth?.mac?.chipName || "Apple M5",
    summary: {
      activeAgentCount,
      totalAgentCount: AGENT_PLATFORMS.length,
      totalTokens: grandTotalTokens,
      totalApiEquivalentCostUsd: Number(totalApiEquivalentCost.toFixed(2)),
      totalSubscriptionCostUsd: Number(totalSubscriptionCost.toFixed(2)),
      totalNetSavingsUsd: Number(totalNetSavings.toFixed(2)),
      savingsMultiplier: Number(savingsMultiplier.toFixed(1)),
      topModel,
      telemetryIncomplete: unreliablePlatforms.length > 0,
      telemetryIncompleteNote,
      unreliablePlatformIds: unreliablePlatforms.map((p) => p.id),
    },
    burn5h: {
      tokens5h,
      costEstimate5hUsd: Number(costEstimate5hUsd.toFixed(2)),
      burnRateTokensPerHour: Math.round(burnRateTokensPerHour),
      burnRateUsdPerHour: Number(burnRateUsdPerHour.toFixed(2)),
    },
    platforms,
    modelDistribution,
  };
}
