import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  persistExternalUsageEvents,
  persistExternalUsageEventsInTransaction,
  type ExternalUsageEventInput,
} from "@/lib/external-usage-events";
import {
  paidRecurringAdoptionCandidate,
  type PaidRecurringAdoptionRecord,
} from "@/lib/external-billing-subscription-adoption";
import { advancePeriod, isSubscriptionInterval, type SubscriptionInterval } from "@/lib/subscriptions";

// Turns each active subscription's elapsed billing periods into synthetic
// ExternalUsageEvent rows (metricType="subscription"), so recurring fees flow
// through the SAME month-to-date sums, daily rollups, per-project attribution,
// and budgets as metered usage — no special-casing in budget-status.
//
// Idempotent two ways: every charge's idempotencyKey is a hash of
// (subscriptionId, periodStart), and the subscription tracks a
// lastChargedPeriodStart watermark. Re-running never double-charges a period
// (the upsert is a no-op on a seen key), so it's safe to call on every
// maintenance cycle.
//
// The event's `provider` string is the provider's (already lowercased) name so
// the charge aggregates under that provider exactly like pushed usage; its
// `projectId` is the subscription's, so per-project budgets pick it up.

// Guard against a subscription whose startDate is far in the past generating an
// unbounded backfill in one pass.
const MAX_PERIODS_PER_RUN = 240;

export const SUBSCRIPTION_SOURCE_APP = "subscription";

export interface MaterializeSubscriptionsResult {
  examined: number;
  charged: number;
  eventsWritten: number;
}

function chargeIdempotencyKey(subscriptionId: string, periodStart: Date): string {
  return crypto
    .createHash("sha256")
    .update(`subscription:${subscriptionId}:${periodStart.toISOString()}`)
    .digest("hex");
}

interface DueSubscription {
  id: string;
  providerId?: string;
  externalAdoptionGuardKey?: string | null;
  name: string;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  projectId: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date | null;
  provider: { name: string; refreshIntervalMin?: number };
}

interface GuardConflictExternalRecord extends PaidRecurringAdoptionRecord {
  providerId: string;
}

interface ChargedManagedIdentity {
  id: string;
  providerId: string;
  externalBillingSource: string | null;
  externalBillingId: string | null;
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date | null;
}

interface ChargePlan {
  inputs: ExternalUsageEventInput[];
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date;
}

// Pure planning step (exported for tests): given a subscription and `now`,
// returns the charges to emit and the advanced cycle fields. Charges every
// period whose start is at or before `now` and past the watermark.
export function planSubscriptionCharges(
  subscription: DueSubscription,
  now: Date
): ChargePlan | null {
  const interval: SubscriptionInterval = isSubscriptionInterval(subscription.interval)
    ? subscription.interval
    : "monthly";
  const intervalCount = Math.max(1, Math.trunc(subscription.intervalCount));

  const inputs: ExternalUsageEventInput[] = [];
  let periodStart = subscription.currentPeriodStart;
  let lastCharged = subscription.lastChargedPeriodStart;
  let latestStarted = subscription.currentPeriodStart;
  const cadencePeriodEnd = advancePeriod(periodStart, interval, intervalCount);
  let nextRenewalAt =
    subscription.nextRenewalAt.getTime() > periodStart.getTime()
      ? new Date(
          Math.min(
            subscription.nextRenewalAt.getTime(),
            cadencePeriodEnd.getTime()
          )
        )
      : cadencePeriodEnd;
  let latestPeriodEnd = nextRenewalAt;
  let guard = 0;

  while (periodStart.getTime() <= now.getTime() && guard < MAX_PERIODS_PER_RUN) {
    guard += 1;
    const periodEnd = nextRenewalAt;

    if (!lastCharged || periodStart.getTime() > lastCharged.getTime()) {
      inputs.push({
        idempotencyKey: chargeIdempotencyKey(subscription.id, periodStart),
        sourceApp: SUBSCRIPTION_SOURCE_APP,
        provider: subscription.provider.name,
        projectId: subscription.projectId,
        service: subscription.name,
        label: subscription.name,
        billingMode: "manual",
        metricType: "subscription",
        unit: "usd",
        costUsd: subscription.costUsd,
        confidence: "actual",
        occurredAt: periodStart,
        windowStart: periodStart,
        windowEnd: periodEnd,
        metadata: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          interval,
          intervalCount,
          currency: subscription.currency,
        },
      });
      lastCharged = periodStart;
    }

    latestStarted = periodStart;
    latestPeriodEnd = periodEnd;
    // A non-auto-renewing subscription is charged for exactly the one term it
    // is in and then stops — never advance into (or charge) a following period.
    if (!subscription.autoRenew) break;
    if (periodEnd.getTime() > now.getTime()) break;
    periodStart = periodEnd;
    nextRenewalAt = advancePeriod(periodStart, interval, intervalCount);
  }

  if (inputs.length === 0) return null;

  return {
    inputs,
    currentPeriodStart: latestStarted,
    nextRenewalAt: latestPeriodEnd,
    lastChargedPeriodStart: lastCharged as Date,
  };
}

function conflictingManagedPeriodStart(
  subscription: DueSubscription,
  plan: ChargePlan,
  externalRecords: GuardConflictExternalRecord[],
  chargedManagedIdentities: ChargedManagedIdentity[],
  refreshIntervalMin: number,
  now: Date
): Date | null {
  const providerId = subscription.providerId;
  const guardKey = subscription.externalAdoptionGuardKey;
  if (!providerId || !guardKey) return null;

  for (const record of externalRecords) {
    const candidate = paidRecurringAdoptionCandidate(
      providerId,
      refreshIntervalMin,
      record,
      now
    );
    if (!candidate || candidate.guardKey !== guardKey) {
      continue;
    }

    for (const managed of chargedManagedIdentities) {
      if (
        managed.id !== subscription.id &&
        managed.providerId === providerId &&
        managed.externalBillingSource === record.source &&
        managed.externalBillingId === record.externalId &&
        managed.lastChargedPeriodStart?.getTime() ===
          managed.currentPeriodStart.getTime() &&
        managed.currentPeriodStart.getTime() ===
          candidate.periodStart.getTime() &&
        managed.nextRenewalAt.getTime() === candidate.periodEnd.getTime() &&
        plan.inputs.some(
          (input) =>
            input.windowStart?.getTime() ===
              candidate.periodStart.getTime() &&
            input.windowEnd?.getTime() === candidate.periodEnd.getTime()
        )
      ) {
        return managed.currentPeriodStart;
      }
    }
  }
  return null;
}

async function resolveGuardedChargePlan(
  subscriptionId: string,
  now: Date
): Promise<
  | { subscription: DueSubscription; plan: ChargePlan }
  | { settled: true; charged: number; eventsWritten: number }
  | null
> {
  return prisma.$transaction(
    async (tx) => {
      // SQLite interactive transactions begin deferred. Take the writer lock
      // before re-reading the guarded row and its collision provenance so a
      // concurrent owner edit cannot be mistaken for the state we settle.
      await tx.$executeRaw`
        UPDATE "Subscription"
        SET "costUsd" = "costUsd"
        WHERE "id" = ${subscriptionId}
      `;
      const subscription = await tx.subscription.findFirst({
        where: {
          id: subscriptionId,
          status: "active",
          currentPeriodStart: { lte: now },
        },
        select: {
          id: true,
          providerId: true,
          externalAdoptionGuardKey: true,
          name: true,
          costUsd: true,
          currency: true,
          interval: true,
          intervalCount: true,
          projectId: true,
          autoRenew: true,
          currentPeriodStart: true,
          nextRenewalAt: true,
          lastChargedPeriodStart: true,
          provider: {
            select: { name: true, refreshIntervalMin: true },
          },
        },
      });
      if (!subscription) return null;

      const plan = planSubscriptionCharges(subscription, now);
      if (!plan) return null;
      if (!subscription.externalAdoptionGuardKey) {
        return { subscription, plan };
      }

      const externalRecords = await tx.providerExternalBilling.findMany({
        where: { providerId: subscription.providerId },
        select: {
          providerId: true,
          source: true,
          externalId: true,
          paidRecurringAuthoritative: true,
          kind: true,
          serviceName: true,
          planName: true,
          status: true,
          amountUsd: true,
          currency: true,
          billingInterval: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          rollupRole: true,
          dateKind: true,
          syncedAt: true,
        },
      });
      const chargedManagedIdentities = await tx.subscription.findMany({
        where: {
          providerId: subscription.providerId,
          externalBillingManaged: true,
          lastChargedPeriodStart: { not: null },
        },
        select: {
          id: true,
          providerId: true,
          externalBillingSource: true,
          externalBillingId: true,
          currentPeriodStart: true,
          nextRenewalAt: true,
          lastChargedPeriodStart: true,
        },
      });
      const settledPeriodStart = conflictingManagedPeriodStart(
        subscription,
        plan,
        externalRecords,
        chargedManagedIdentities,
        subscription.provider.refreshIntervalMin,
        now
      );
      if (!settledPeriodStart) return { subscription, plan };

      // Suppress only the proven overlapping input. Any earlier/non-overlap
      // inputs must materialize before the monotonic watermark advances past
      // them, or a June+July plan could permanently omit June when only July
      // overlaps. Persistence and watermark/cycle advancement share this
      // writer-locked transaction, so failure rolls both back and replay stays
      // idempotent.
      const nonOverlappingInputs = plan.inputs.filter(
        (input) =>
          input.windowStart?.getTime() !== settledPeriodStart.getTime()
      );
      const persisted = await persistExternalUsageEventsInTransaction(
        tx,
        nonOverlappingInputs
      );
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          currentPeriodStart: plan.currentPeriodStart,
          nextRenewalAt: plan.nextRenewalAt,
          lastChargedPeriodStart: plan.lastChargedPeriodStart,
        },
      });
      return {
        settled: true,
        charged: nonOverlappingInputs.length > 0 ? 1 : 0,
        eventsWritten: persisted.persisted,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 20_000,
    }
  );
}

export async function materializeDueSubscriptions(
  now: Date = new Date()
): Promise<MaterializeSubscriptionsResult> {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: "active", currentPeriodStart: { lte: now } },
    select: {
      id: true,
      providerId: true,
      externalAdoptionGuardKey: true,
      name: true,
      costUsd: true,
      currency: true,
      interval: true,
      intervalCount: true,
      projectId: true,
      autoRenew: true,
      currentPeriodStart: true,
      nextRenewalAt: true,
      lastChargedPeriodStart: true,
      provider: { select: { name: true } },
    },
  });

  let charged = 0;
  let eventsWritten = 0;

  for (const observedSubscription of subscriptions) {
    let subscription: DueSubscription = observedSubscription;
    let plan = planSubscriptionCharges(subscription, now);
    if (!plan) continue;

    // An owner-controlled guarded row can coexist with an older managed row
    // after the provider corrects a charge shape (for example $5 -> $6). Do
    // preserve that manual row's owner-controlled terms/status/guard, but also
    // do not emit a second same-period event while the linked managed identity
    // proves the period was already charged. The guarded transactional recheck
    // records only a settlement watermark; an owner reanchor to a later period
    // remains independently billable.
    if (subscription.externalAdoptionGuardKey) {
      const guarded = await resolveGuardedChargePlan(subscription.id, now);
      if (!guarded) continue;
      if ("settled" in guarded) {
        charged += guarded.charged;
        eventsWritten += guarded.eventsWritten;
        continue;
      }
      subscription = guarded.subscription;
      plan = guarded.plan;
    }

    const persistResult = await persistExternalUsageEvents(plan.inputs);
    eventsWritten += persistResult.persisted;
    charged += 1;

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodStart: plan.currentPeriodStart,
        nextRenewalAt: plan.nextRenewalAt,
        lastChargedPeriodStart: plan.lastChargedPeriodStart,
      },
    });
  }

  return { examined: subscriptions.length, charged, eventsWritten };
}
