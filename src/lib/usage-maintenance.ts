import { deliverProviderAlerts, type AlertDeliveryResult } from "@/lib/alert-delivery";
import {
  runScheduledDataRetentionMaintenance,
  type DataRetentionResult,
  type ScheduledRetentionSkipped,
} from "@/lib/data-retention";
import {
  materializeDueSubscriptions,
  type MaterializeSubscriptionsResult,
} from "@/lib/subscription-materializer";
import {
  rollForwardProviderRenewals,
  type RollForwardProviderRenewalsResult,
} from "@/lib/provider-renewals";

export interface UsageMaintenanceResult {
  subscriptions: MaterializeSubscriptionsResult;
  providerRenewals: RollForwardProviderRenewalsResult;
  retention: DataRetentionResult | ScheduledRetentionSkipped;
  alerts: AlertMaintenanceResult;
}

export interface DeferredAlertMaintenanceError {
  stage: "alerts";
  code: "P1008";
  model: "ProviderAlertNotification";
  message: string;
}

export interface AlertMaintenanceResult extends AlertDeliveryResult {
  deferredError: DeferredAlertMaintenanceError | null;
}

export interface UsageMaintenanceDependencies {
  materializeSubscriptions?: typeof materializeDueSubscriptions;
  rollForwardRenewals?: typeof rollForwardProviderRenewals;
  runRetention?: typeof runScheduledDataRetentionMaintenance;
  deliverAlerts?: typeof deliverProviderAlerts;
}

let maintenanceInFlight: Promise<UsageMaintenanceResult> | null = null;

function isDeferrableAlertNotificationTimeout(error: unknown): error is Error & {
  code: "P1008";
  meta: { modelName: "ProviderAlertNotification" };
} {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; meta?: unknown };
  if (candidate.code !== "P1008" || typeof candidate.meta !== "object" || !candidate.meta) {
    return false;
  }
  return (
    "modelName" in candidate.meta &&
    candidate.meta.modelName === "ProviderAlertNotification"
  );
}

function deferredAlertMaintenanceError(
  error: Error & {
    code: "P1008";
    meta: { modelName: "ProviderAlertNotification" };
  }
): DeferredAlertMaintenanceError {
  return {
    stage: "alerts",
    code: error.code,
    model: error.meta.modelName,
    message: error.message,
  };
}

export async function runUsageMaintenance(
  dependencies: UsageMaintenanceDependencies = {}
): Promise<UsageMaintenanceResult> {
  if (maintenanceInFlight) return maintenanceInFlight;

  const run = (async () => {
    // Materialize subscription charges and advance provider renewals BEFORE
    // retention so newly-generated subscription events roll up in the same
    // pass, and BEFORE alerts so budget/renewal alerts see current state.
    const subscriptions = await (
      dependencies.materializeSubscriptions ?? materializeDueSubscriptions
    )();
    const providerRenewals = await (
      dependencies.rollForwardRenewals ?? rollForwardProviderRenewals
    )();
    const retention = await (
      dependencies.runRetention ?? runScheduledDataRetentionMaintenance
    )();

    let alerts: AlertMaintenanceResult;
    try {
      alerts = {
        ...(await (dependencies.deliverAlerts ?? deliverProviderAlerts)()),
        deferredError: null,
      };
    } catch (error) {
      if (!isDeferrableAlertNotificationTimeout(error)) throw error;

      // Provider polling and money-path maintenance have already committed.
      // The notification summary write is safe to defer: any channel send is
      // persisted first in ProviderAlertChannelDelivery. Do not broaden this
      // catch to channel-state writes, where retrying can duplicate a send.
      console.error(
        "[usage-maintenance] alert notification bookkeeping timed out; deferring until the next cycle",
        error
      );
      alerts = {
        evaluatedProviders: 0,
        activeAlerts: 0,
        sent: 0,
        resolved: 0,
        skipped: 0,
        errors: [],
        deferredError: deferredAlertMaintenanceError(error),
      };
    }
    return { subscriptions, providerRenewals, retention, alerts };
  })();

  maintenanceInFlight = run;
  try {
    return await run;
  } finally {
    if (maintenanceInFlight === run) maintenanceInFlight = null;
  }
}
