import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeBudgetStatus } from "@/lib/budget-status";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

// ---------------------------------------------------------------------------
// Budget-breach automated control actions (DESIGN: default-off, reversible,
// audited, hysteresis, fail-safe, recommendation-only key handling).
//
// Today's alerting is NOTIFY-ONLY. This module adds guarded automated
// responses when a provider breaches its configured monthly budget:
//   1. pause that provider's polling (stop incurring/observing further),
//   2. surface a key-disable RECOMMENDATION (advisory data only — it NEVER
//      disables or revokes a credential; key revocation is owner-only per the
//      safety rules),
//   3. a durable spend-cap / breach state on the provider that the dashboard
//      shows and that gates the pause.
//
// SAFETY MODEL
//   - DEFAULT-OFF: every automated action is gated behind BOTH the master env
//     flag BUDGET_AUTO_CONTROLS_ENABLED (default false) AND a per-provider
//     opt-in (Provider.budgetControlsEnabled, default false). With the master
//     flag off, applyBudgetControls does ZERO I/O and returns immediately, so
//     behavior is byte-identical to the notify-only path (proven by test).
//   - REVERSIBLE + AUDITED: pausing writes durable, additive state
//     (budgetPausedAt/budgetBreachState/reason/threshold) and is never
//     destructive. It auto-clears when the breach resolves (spend falls back
//     under a resume band) or the UTC budget period rolls. Every state change
//     appends a BudgetControlEvent audit row.
//   - HYSTERESIS / anti-flap: a pause requires a SUSTAINED breach — N
//     consecutive breach observations (BUDGET_CONTROL_BREACH_TICKS) — plus a
//     cooldown before re-acting, mirroring the scheduler's
//     provider_fetch_degraded consecutive-tick latch. Resume uses a lower band
//     (BUDGET_CONTROL_RESUME_MARGIN_RATIO) than the pause threshold so a spend
//     hovering at the budget line cannot oscillate pause/resume every tick.
//   - FAIL-SAFE: if the control layer errors, it must NOT break the
//     scheduler/poll cycle. applyBudgetControls swallows all errors, logs, and
//     degrades to notify-only (returns degraded:true) instead of throwing.
// ---------------------------------------------------------------------------

export type BudgetBreachState = "ok" | "breached" | "paused";

export const BUDGET_BREACH_STATES: readonly BudgetBreachState[] = [
  "ok",
  "breached",
  "paused",
];

export type BudgetControlAction =
  | "pause"
  | "resume_breach_resolved"
  | "resume_period_roll"
  | "resume_controls_disabled"
  | "recommend_key_disable"
  | "clear_key_disable_recommendation"
  | "breach_observed"
  | "breach_cleared";

const DEFAULT_BREACH_TICKS = 3;
const DEFAULT_BREACH_MARGIN_RATIO = 1.0;
const DEFAULT_RESUME_MARGIN_RATIO = 0.9;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export interface BudgetControlConfig {
  masterEnabled: boolean;
  breachTicks: number;
  breachMarginRatio: number;
  resumeMarginRatio: number;
  cooldownMs: number;
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Master gate. When false the entire control layer is inert (byte-identical to notify-only). */
export function budgetAutoControlsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return parseBooleanFlag(env.BUDGET_AUTO_CONTROLS_ENABLED);
}

export function readBudgetControlConfig(
  env: NodeJS.ProcessEnv = process.env
): BudgetControlConfig {
  return {
    masterEnabled: budgetAutoControlsEnabled(env),
    // At least 1 breach observation; a very large N would effectively disable
    // pausing, which is a safe (notify-only) failure mode.
    breachTicks: Math.floor(
      boundedNumber(env.BUDGET_CONTROL_BREACH_TICKS, DEFAULT_BREACH_TICKS, {
        min: 1,
        max: 1000,
      })
    ),
    // Pause threshold multiplier on the monthly budget. 1.0 = pause at/over
    // budget; 1.1 tolerates a 10% overage before pausing.
    breachMarginRatio: boundedNumber(
      env.BUDGET_CONTROL_BREACH_MARGIN_RATIO,
      DEFAULT_BREACH_MARGIN_RATIO,
      { min: 1, max: 100 }
    ),
    // Resume band multiplier on the monthly budget. Must be <= 1 so resume
    // requires spend to fall strictly under the budget line, never equal to the
    // pause threshold (that would flap).
    resumeMarginRatio: boundedNumber(
      env.BUDGET_CONTROL_RESUME_MARGIN_RATIO,
      DEFAULT_RESUME_MARGIN_RATIO,
      { min: 0, max: 1 }
    ),
    cooldownMs: boundedNumber(
      env.BUDGET_CONTROL_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
      { min: 0, max: 30 * 24 * 60 * 60 * 1000 }
    ),
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// Pure decision layer. No I/O, no wall clock, no randomness — fully
// deterministic given (state, observation, config, now). This is where the
// hysteresis/anti-flap/reversibility invariants live so they can be unit
// tested in isolation from the database.
// ---------------------------------------------------------------------------

export interface BudgetControlProviderState {
  budgetControlsEnabled: boolean;
  budgetBreachState: BudgetBreachState;
  budgetBreachStreak: number;
  budgetControlPeriodStart: Date | null;
  budgetPausedAt: Date | null;
  budgetPauseReason: string | null;
  budgetPauseThresholdUsd: number | null;
  budgetPauseObservedSpendUsd: number | null;
  budgetControlLastActionAt: Date | null;
  keyDisableRecommended: boolean;
}

export interface BudgetControlObservation {
  monthlyBudgetUsd: number | null;
  spentUsd: number;
}

export interface BudgetControlEventDraft {
  action: BudgetControlAction;
  reason: string;
  breachState: BudgetBreachState;
  thresholdUsd: number | null;
  observedSpendUsd: number | null;
  breachStreak: number | null;
  periodStart: Date;
}

export interface BudgetControlDecision {
  changed: boolean;
  next: BudgetControlProviderState;
  events: BudgetControlEventDraft[];
  paused: boolean;
  resumed: boolean;
  recommendationRaised: boolean;
  recommendationCleared: boolean;
  breachObserved: boolean;
}

function cleanState(
  state: BudgetControlProviderState,
  periodStart: Date
): BudgetControlProviderState {
  return {
    budgetControlsEnabled: state.budgetControlsEnabled,
    budgetBreachState: "ok",
    budgetBreachStreak: 0,
    budgetControlPeriodStart: periodStart,
    budgetPausedAt: null,
    budgetPauseReason: null,
    budgetPauseThresholdUsd: null,
    budgetPauseObservedSpendUsd: null,
    budgetControlLastActionAt: state.budgetControlLastActionAt,
    keyDisableRecommended: false,
  };
}

function hasResidualControlState(state: BudgetControlProviderState): boolean {
  return (
    state.budgetBreachState !== "ok" ||
    state.budgetBreachStreak !== 0 ||
    state.budgetPausedAt !== null ||
    state.keyDisableRecommended
  );
}

function statesEqual(
  a: BudgetControlProviderState,
  b: BudgetControlProviderState
): boolean {
  return (
    a.budgetBreachState === b.budgetBreachState &&
    a.budgetBreachStreak === b.budgetBreachStreak &&
    (a.budgetControlPeriodStart?.getTime() ?? null) ===
      (b.budgetControlPeriodStart?.getTime() ?? null) &&
    (a.budgetPausedAt?.getTime() ?? null) ===
      (b.budgetPausedAt?.getTime() ?? null) &&
    a.budgetPauseReason === b.budgetPauseReason &&
    a.budgetPauseThresholdUsd === b.budgetPauseThresholdUsd &&
    a.budgetPauseObservedSpendUsd === b.budgetPauseObservedSpendUsd &&
    (a.budgetControlLastActionAt?.getTime() ?? null) ===
      (b.budgetControlLastActionAt?.getTime() ?? null) &&
    a.keyDisableRecommended === b.keyDisableRecommended
  );
}

export function decideBudgetControlAction(
  state: BudgetControlProviderState,
  observation: BudgetControlObservation,
  config: BudgetControlConfig,
  now: Date
): BudgetControlDecision {
  const periodStart = monthStartUtc(now);
  const events: BudgetControlEventDraft[] = [];
  const noChange: BudgetControlDecision = {
    changed: false,
    next: state,
    events,
    paused: false,
    resumed: false,
    recommendationRaised: false,
    recommendationCleared: false,
    breachObserved: false,
  };

  // Not under active control (master off is handled by the caller, but a
  // per-provider opt-out while the master flag is on must revert any residual
  // pause/recommendation — the feature turning off for a provider fully
  // resumes it). No opt-in and no residue => nothing to do.
  if (!config.masterEnabled || !state.budgetControlsEnabled) {
    if (!hasResidualControlState(state)) return noChange;
    const next = cleanState(state, periodStart);
    next.budgetControlLastActionAt = now;
    events.push({
      action: "resume_controls_disabled",
      reason: "Budget auto-controls disabled for this provider; pause reverted.",
      breachState: "ok",
      thresholdUsd: null,
      observedSpendUsd: observation.spentUsd,
      breachStreak: 0,
      periodStart,
    });
    return {
      changed: true,
      next,
      events,
      paused: false,
      resumed: state.budgetPausedAt !== null,
      recommendationRaised: false,
      recommendationCleared: state.keyDisableRecommended,
      breachObserved: false,
    };
  }

  const next: BudgetControlProviderState = { ...state };
  let paused = false;
  let resumed = false;
  let recommendationRaised = false;
  let recommendationCleared = false;
  let breachObserved = false;

  // --- Period roll: a new UTC month resets hysteresis and resumes any pause,
  // because a fresh budget period is a legitimately new spend window, not flap.
  const periodRolled =
    state.budgetControlPeriodStart != null &&
    state.budgetControlPeriodStart.getTime() !== periodStart.getTime();
  if (periodRolled) {
    if (next.budgetPausedAt !== null) {
      resumed = true;
      recommendationCleared = next.keyDisableRecommended;
      events.push({
        action: "resume_period_roll",
        reason:
          "Budget period rolled to a new UTC month; pause auto-cleared for the new period.",
        breachState: "ok",
        thresholdUsd: null,
        observedSpendUsd: observation.spentUsd,
        breachStreak: 0,
        periodStart,
      });
    }
    next.budgetBreachState = "ok";
    next.budgetBreachStreak = 0;
    next.budgetPausedAt = null;
    next.budgetPauseReason = null;
    next.budgetPauseThresholdUsd = null;
    next.budgetPauseObservedSpendUsd = null;
    next.keyDisableRecommended = false;
    if (resumed) next.budgetControlLastActionAt = now;
  }
  next.budgetControlPeriodStart = periodStart;

  const budget = observation.monthlyBudgetUsd;
  const budgetConfigured = budget != null && budget > 0;
  const threshold = budgetConfigured ? budget * config.breachMarginRatio : null;
  const resumeCeiling = budgetConfigured
    ? budget * config.resumeMarginRatio
    : null;
  const inBreach =
    budgetConfigured && threshold != null && observation.spentUsd >= threshold;

  const cooldownElapsed =
    next.budgetControlLastActionAt == null ||
    now.getTime() - next.budgetControlLastActionAt.getTime() >=
      config.cooldownMs;

  if (inBreach) {
    if (next.budgetPausedAt !== null) {
      // Already paused and still in breach — freeze state (no churn, no flap).
    } else {
      const newStreak = next.budgetBreachStreak + 1;
      next.budgetBreachStreak = newStreak;
      if (next.budgetBreachState === "ok") {
        next.budgetBreachState = "breached";
        breachObserved = true;
        events.push({
          action: "breach_observed",
          reason: `Spend ${observation.spentUsd} reached the pause threshold ${threshold}.`,
          breachState: "breached",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: newStreak,
          periodStart,
        });
      }
      if (newStreak >= config.breachTicks && cooldownElapsed) {
        next.budgetBreachState = "paused";
        next.budgetPausedAt = now;
        next.budgetPauseReason = `Sustained budget breach: spend ${observation.spentUsd} at/over pause threshold ${threshold} for ${newStreak} consecutive observation(s).`;
        next.budgetPauseThresholdUsd = threshold;
        next.budgetPauseObservedSpendUsd = observation.spentUsd;
        next.budgetControlLastActionAt = now;
        next.keyDisableRecommended = true;
        paused = true;
        recommendationRaised = true;
        events.push({
          action: "pause",
          reason: next.budgetPauseReason,
          breachState: "paused",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: newStreak,
          periodStart,
        });
        events.push({
          action: "recommend_key_disable",
          reason:
            "Provider paused on sustained budget breach. RECOMMENDATION ONLY: consider disabling or rotating this key. No credential was modified.",
          breachState: "paused",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: newStreak,
          periodStart,
        });
      }
    }
  } else {
    // Not in breach this observation.
    if (next.budgetPausedAt !== null) {
      // Only resume when spend has fallen under the (lower) resume band AND the
      // cooldown has elapsed — the dead-band between resumeCeiling and the
      // pause threshold is where we hold the pause to avoid oscillation.
      const belowResumeBand =
        resumeCeiling == null || observation.spentUsd <= resumeCeiling;
      if (belowResumeBand && cooldownElapsed) {
        resumed = true;
        recommendationCleared = next.keyDisableRecommended;
        next.budgetBreachState = "ok";
        next.budgetBreachStreak = 0;
        next.budgetPausedAt = null;
        next.budgetPauseReason = null;
        next.budgetPauseThresholdUsd = null;
        next.budgetPauseObservedSpendUsd = null;
        next.budgetControlLastActionAt = now;
        next.keyDisableRecommended = false;
        events.push({
          action: "resume_breach_resolved",
          reason: `Budget breach resolved: spend ${observation.spentUsd} fell to/under the resume band ${resumeCeiling}. Polling resumed.`,
          breachState: "ok",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: 0,
          periodStart,
        });
        events.push({
          action: "clear_key_disable_recommendation",
          reason: "Budget breach resolved; key-disable recommendation cleared.",
          breachState: "ok",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: 0,
          periodStart,
        });
      }
      // else: hold the pause (dead-band or cooldown) — no change.
    } else if (next.budgetBreachState === "breached" || next.budgetBreachStreak > 0) {
      // Partial hysteresis progress that never reached a pause — clear it.
      const hadProgress =
        next.budgetBreachState === "breached" || next.budgetBreachStreak > 0;
      next.budgetBreachState = "ok";
      next.budgetBreachStreak = 0;
      if (hadProgress) {
        events.push({
          action: "breach_cleared",
          reason: `Spend ${observation.spentUsd} fell under threshold before pausing; breach progress cleared.`,
          breachState: "ok",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: 0,
          periodStart,
        });
      }
    }
  }

  const changed = !statesEqual(state, next) || events.length > 0;
  return {
    changed,
    next,
    events,
    paused,
    resumed,
    recommendationRaised,
    recommendationCleared,
    breachObserved,
  };
}

// ---------------------------------------------------------------------------
// Side-effectful apply layer. Reads the current per-provider control state +
// canonical budget spend, runs the pure decider, and persists state + audit
// rows. The WHOLE body is fail-safe: any error is logged and degraded to
// notify-only (degraded:true) rather than propagated to the scheduler.
// ---------------------------------------------------------------------------

type BudgetControlsPrisma = Pick<
  PrismaClient,
  "provider" | "budgetControlEvent" | "$transaction"
>;

export interface ApplyBudgetControlsOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  prismaClient?: BudgetControlsPrisma;
  computeStatus?: (
    now: Date
  ) => Promise<{
    providers: Array<{
      id: string;
      monthlyBudgetUsd: number | null;
      spentUsd: number;
    }>;
  }>;
  /** When true (default off the injected path) writes are wrapped in the internal SQLite write-admission lease. */
  useWriteAdmission?: boolean;
}

export interface BudgetControlsResult {
  enabled: boolean;
  evaluated: number;
  paused: number;
  resumed: number;
  recommendationsRaised: number;
  recommendationsCleared: number;
  breachesObserved: number;
  auditRowsWritten: number;
  degraded: boolean;
  error?: string;
}

function emptyResult(enabled: boolean): BudgetControlsResult {
  return {
    enabled,
    evaluated: 0,
    paused: 0,
    resumed: 0,
    recommendationsRaised: 0,
    recommendationsCleared: 0,
    breachesObserved: 0,
    auditRowsWritten: 0,
    degraded: false,
  };
}

export async function applyBudgetControls(
  options: ApplyBudgetControlsOptions = {}
): Promise<BudgetControlsResult> {
  const env = options.env ?? process.env;
  const config = readBudgetControlConfig(env);

  // Master gate: OFF => zero I/O, byte-identical to notify-only.
  if (!config.masterEnabled) {
    return emptyResult(false);
  }

  const now = options.now ?? new Date();
  const db = options.prismaClient ?? prisma;
  const computeStatus = options.computeStatus ?? computeBudgetStatus;
  // Default to admission-wrapped writes only on the shared prisma singleton.
  const useAdmission = options.useWriteAdmission ?? options.prismaClient == null;
  const result = emptyResult(true);

  try {
    const [providers, budget] = await Promise.all([
      db.provider.findMany({
        where: {
          OR: [
            { budgetControlsEnabled: true },
            // Also sweep any provider carrying residual control state so an
            // opt-out reverts a prior pause even if the row is no longer
            // opted in.
            { budgetBreachState: { not: "ok" } },
            { budgetPausedAt: { not: null } },
            { keyDisableRecommended: true },
          ],
        },
        select: {
          id: true,
          budgetControlsEnabled: true,
          budgetBreachState: true,
          budgetBreachStreak: true,
          budgetControlPeriodStart: true,
          budgetPausedAt: true,
          budgetPauseReason: true,
          budgetPauseThresholdUsd: true,
          budgetPauseObservedSpendUsd: true,
          budgetControlLastActionAt: true,
          keyDisableRecommended: true,
        },
      }),
      computeStatus(now),
    ]);

    const spendByProviderId = new Map(
      budget.providers.map((entry) => [entry.id, entry])
    );

    for (const provider of providers) {
      try {
        const spend = spendByProviderId.get(provider.id);
        const observation: BudgetControlObservation = {
          monthlyBudgetUsd: spend?.monthlyBudgetUsd ?? null,
          spentUsd: spend?.spentUsd ?? 0,
        };
        const state: BudgetControlProviderState = {
          budgetControlsEnabled: provider.budgetControlsEnabled,
          budgetBreachState: normalizeBreachState(provider.budgetBreachState),
          budgetBreachStreak: provider.budgetBreachStreak,
          budgetControlPeriodStart: provider.budgetControlPeriodStart,
          budgetPausedAt: provider.budgetPausedAt,
          budgetPauseReason: provider.budgetPauseReason,
          budgetPauseThresholdUsd: provider.budgetPauseThresholdUsd,
          budgetPauseObservedSpendUsd: provider.budgetPauseObservedSpendUsd,
          budgetControlLastActionAt: provider.budgetControlLastActionAt,
          keyDisableRecommended: provider.keyDisableRecommended,
        };

        if (config.masterEnabled && provider.budgetControlsEnabled) {
          result.evaluated += 1;
        }

        const decision = decideBudgetControlAction(
          state,
          observation,
          config,
          now
        );
        if (!decision.changed) continue;

        const write = async () => {
          await db.$transaction(async (tx) => {
            await tx.provider.update({
              where: { id: provider.id },
              data: {
                budgetBreachState: decision.next.budgetBreachState,
                budgetBreachStreak: decision.next.budgetBreachStreak,
                budgetControlPeriodStart:
                  decision.next.budgetControlPeriodStart,
                budgetPausedAt: decision.next.budgetPausedAt,
                budgetPauseReason: decision.next.budgetPauseReason,
                budgetPauseThresholdUsd: decision.next.budgetPauseThresholdUsd,
                budgetPauseObservedSpendUsd:
                  decision.next.budgetPauseObservedSpendUsd,
                budgetControlLastActionAt:
                  decision.next.budgetControlLastActionAt,
                keyDisableRecommended: decision.next.keyDisableRecommended,
              },
            });
            for (const event of decision.events) {
              await tx.budgetControlEvent.create({
                data: {
                  providerId: provider.id,
                  action: event.action,
                  reason: event.reason,
                  breachState: event.breachState,
                  thresholdUsd: event.thresholdUsd,
                  observedSpendUsd: event.observedSpendUsd,
                  breachStreak: event.breachStreak,
                  periodStart: event.periodStart,
                },
              });
            }
          });
        };

        if (useAdmission) {
          await withInternalUsageWriteAdmission(write);
        } else {
          await write();
        }

        result.auditRowsWritten += decision.events.length;
        if (decision.paused) result.paused += 1;
        if (decision.resumed) result.resumed += 1;
        if (decision.recommendationRaised) result.recommendationsRaised += 1;
        if (decision.recommendationCleared) result.recommendationsCleared += 1;
        if (decision.breachObserved) result.breachesObserved += 1;
      } catch (providerError) {
        // One bad provider must not abort the rest, and must never break the
        // scheduler cycle. Degrade to notify-only for this provider.
        result.degraded = true;
        // eslint-disable-next-line no-console -- surfaces control-layer failures for on-call visibility
        console.error(
          `[budget-controls] provider ${provider.id} control evaluation failed; degrading to notify-only`,
          providerError
        );
      }
    }

    return result;
  } catch (error) {
    // Total fail-safe: never throw out of the control layer. The caller (usage
    // maintenance / scheduler) keeps running exactly as the notify-only path.
    // eslint-disable-next-line no-console -- surfaces control-layer failures for on-call visibility
    console.error(
      "[budget-controls] control evaluation failed; degrading to notify-only",
      error
    );
    return {
      ...emptyResult(true),
      degraded: true,
      error: error instanceof Error ? error.message : "Unknown budget-controls failure",
    };
  }
}

function normalizeBreachState(value: string): BudgetBreachState {
  return value === "breached" || value === "paused" ? value : "ok";
}

// ---------------------------------------------------------------------------
// Scheduler helper. A provider's polling is paused ONLY when the master flag is
// on, the provider is opted in, and it carries a durable pause. Gating the skip
// on the master flag makes BUDGET_AUTO_CONTROLS_ENABLED=false a clean
// kill-switch: flipping it off immediately resumes polling of every provider
// regardless of any residual DB state.
// ---------------------------------------------------------------------------
export function budgetPollingPaused(
  provider: {
    budgetControlsEnabled?: boolean | null;
    budgetPausedAt?: Date | null;
  },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!budgetAutoControlsEnabled(env)) return false;
  return Boolean(provider.budgetControlsEnabled) && provider.budgetPausedAt != null;
}
