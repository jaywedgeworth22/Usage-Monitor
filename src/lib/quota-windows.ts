export type QuotaWindowStatus = "available" | "near_cap" | "exhausted" | "unknown";

export interface QuotaEventLike {
  provider: string;
  service?: string | null;
  label?: string | null;
  credits?: number | null;
  limit?: number | null;
  occurredAt: Date | string;
  metadata?: unknown;
}

export interface SkipModelType {
  instanceId: string;
  model: string;
}

export interface QuotaWindow {
  id: string;
  provider: string;
  sourceApp: string | null;
  modelId: string | null;
  modelType: string | null;
  label: string;
  remainingPercent: number | null;
  remainingUnknown: boolean;
  isExhausted: boolean;
  resetAt: string | null;
  window: string | null;
  status: QuotaWindowStatus;
  skip: boolean;
  skipReason: string | null;
  occurredAt: string;
  source: string | null;
}

export interface QuotaWindowsResponse {
  generatedAt: string;
  windows: QuotaWindow[];
  skipModelTypes: SkipModelType[];
}

const ANTIGRAVITY_INSTANCE = "antigravity";

const CLAUDE_GPT_MODELS = [
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-6",
  "gpt-oss-120b-medium",
];

const GEMINI_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3-flash",
];

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function quotaStatus(input: {
  remainingPercent: number | null;
  remainingUnknown: boolean;
  isExhausted: boolean;
}): QuotaWindowStatus {
  if (input.isExhausted || (input.remainingPercent != null && input.remainingPercent <= 0)) {
    return "exhausted";
  }
  if (input.remainingUnknown || input.remainingPercent == null) return "unknown";
  if (input.remainingPercent < 20) return "near_cap";
  return "available";
}

function skipTargetsFor(window: QuotaWindow): SkipModelType[] {
  if (!window.skip) return [];
  if (window.modelId) {
    return [{ instanceId: ANTIGRAVITY_INSTANCE, model: window.modelId }];
  }
  const group = `${window.label} ${window.provider}`.toLowerCase();
  if (group.includes("claude") || group.includes("gpt")) {
    return CLAUDE_GPT_MODELS.map((model) => ({ instanceId: ANTIGRAVITY_INSTANCE, model }));
  }
  if (group.includes("gemini")) {
    return GEMINI_MODELS.map((model) => ({ instanceId: ANTIGRAVITY_INSTANCE, model }));
  }
  return [];
}

export function projectQuotaWindows(
  events: QuotaEventLike[],
  now = new Date(),
): QuotaWindowsResponse {
  const latest = new Map<string, QuotaWindow>();
  for (const event of events) {
    const meta = asRecord(event.metadata);
    const modelId = asString(meta.modelId);
    const bucketId = asString(meta.bucketId);
    const series = modelId ?? bucketId ?? `${event.provider}:${event.label ?? ""}`;
    if (latest.has(series)) continue;

    const limit = typeof event.limit === "number" && event.limit > 0 ? event.limit : 100;
    const remainingUnknown = asBoolean(meta.remainingUnknown) || event.credits == null;
    const remainingPercent =
      remainingUnknown || event.credits == null
        ? null
        : Math.round((event.credits / limit) * 10_000) / 100;
    const isExhausted =
      asBoolean(meta.isExhausted) || (remainingPercent != null && remainingPercent <= 0);
    const status = quotaStatus({ remainingPercent, remainingUnknown, isExhausted });
    latest.set(series, {
      id: series,
      provider: event.provider,
      sourceApp: event.service ?? null,
      modelId,
      modelType: modelId,
      label: event.label ?? modelId ?? event.provider,
      remainingPercent,
      remainingUnknown,
      isExhausted,
      resetAt: asString(meta.resetAt),
      window: asString(meta.quotaWindow),
      status,
      skip: status === "exhausted",
      skipReason:
        status === "exhausted"
          ? `${event.label ?? modelId ?? "model"} remaining ${remainingPercent ?? 0}%`
          : null,
      occurredAt: iso(event.occurredAt),
      source: asString(meta.source),
    });
  }

  const windows = [...latest.values()];
  const skipModelTypes: SkipModelType[] = [];
  const seenSkip = new Set<string>();
  for (const window of windows) {
    for (const target of skipTargetsFor(window)) {
      const key = `${target.instanceId}:${target.model}`;
      if (seenSkip.has(key)) continue;
      seenSkip.add(key);
      skipModelTypes.push(target);
    }
  }

  return {
    generatedAt: now.toISOString(),
    windows,
    skipModelTypes,
  };
}
