import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertDeliveryResult } from "../alert-delivery";
import type { ScheduledRetentionSkipped } from "../data-retention";
import type { RollForwardProviderRenewalsResult } from "../provider-renewals";
import type { MaterializeSubscriptionsResult } from "../subscription-materializer";
import { runUsageMaintenance, type UsageMaintenanceDependencies } from "../usage-maintenance";

const subscriptions: MaterializeSubscriptionsResult = {
  examined: 2,
  charged: 1,
  eventsWritten: 1,
};
const providerRenewals: RollForwardProviderRenewalsResult = {
  examined: 1,
  advanced: 1,
};
const retention: ScheduledRetentionSkipped = { skipped: true, reason: "interval" };
const deliveredAlerts: AlertDeliveryResult = {
  evaluatedProviders: 4,
  activeAlerts: 2,
  sent: 1,
  resolved: 1,
  skipped: 0,
  errors: [],
};

function dependencies(
  deliverAlerts: UsageMaintenanceDependencies["deliverAlerts"]
): UsageMaintenanceDependencies {
  return {
    materializeSubscriptions: vi.fn(async () => subscriptions),
    rollForwardRenewals: vi.fn(async () => providerRenewals),
    runRetention: vi.fn(async () => retention),
    deliverAlerts,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runUsageMaintenance", () => {
  it("returns a structured degraded alert result without failing completed money-path stages", async () => {
    const error = Object.assign(new Error("SQLite socket timeout"), {
      code: "P1008",
      meta: { modelName: "ProviderAlertNotification" },
    });
    const deliverAlerts = vi.fn(async () => {
      throw error;
    });
    const deps = dependencies(deliverAlerts);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runUsageMaintenance(deps)).resolves.toEqual({
      subscriptions,
      providerRenewals,
      retention,
      alerts: {
        evaluatedProviders: 0,
        activeAlerts: 0,
        sent: 0,
        resolved: 0,
        skipped: 0,
        errors: [],
        deferredError: {
          stage: "alerts",
          code: "P1008",
          model: "ProviderAlertNotification",
          message: "SQLite socket timeout",
        },
      },
    });
    expect(deliverAlerts).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not retry in the same cycle and retries normally on the next invocation", async () => {
    const deliverAlerts = vi
      .fn<() => Promise<AlertDeliveryResult>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("busy"), {
          code: "P1008",
          meta: { modelName: "ProviderAlertNotification" },
        })
      )
      .mockResolvedValueOnce(deliveredAlerts);
    const deps = dependencies(deliverAlerts);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await runUsageMaintenance(deps);
    expect(first.alerts.deferredError?.code).toBe("P1008");
    expect(deliverAlerts).toHaveBeenCalledTimes(1);

    const second = await runUsageMaintenance(deps);
    expect(second.alerts).toEqual({ ...deliveredAlerts, deferredError: null });
    expect(deliverAlerts).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent callers into one degraded alert pass and clears in-flight state", async () => {
    let rejectAlerts: ((error: Error) => void) | undefined;
    const deliverAlerts = vi.fn(
      () =>
        new Promise<AlertDeliveryResult>((_resolve, reject) => {
          rejectAlerts = reject;
        })
    );
    const deps = dependencies(deliverAlerts);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = runUsageMaintenance(deps);
    const second = runUsageMaintenance(deps);
    await vi.waitFor(() => expect(rejectAlerts).toBeTypeOf("function"));
    rejectAlerts?.(
      Object.assign(new Error("locked"), {
        code: "P1008",
        meta: { modelName: "ProviderAlertNotification" },
      })
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(deliverAlerts).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();

    const nextDeliverAlerts = vi.fn(async () => deliveredAlerts);
    const next = await runUsageMaintenance(dependencies(nextDeliverAlerts));
    expect(next.alerts.deferredError).toBeNull();
    expect(nextDeliverAlerts).toHaveBeenCalledOnce();
  });

  it.each([
    "materializeSubscriptions",
    "rollForwardRenewals",
    "runRetention",
  ] as const)("keeps %s failures fatal", async (stage) => {
    const failure = new Error(`${stage} failed`);
    const deliverAlerts = vi.fn(async () => deliveredAlerts);
    const deps = dependencies(deliverAlerts);

    if (stage === "materializeSubscriptions") {
      deps.materializeSubscriptions = vi.fn(async () => {
        throw failure;
      });
    } else if (stage === "rollForwardRenewals") {
      deps.rollForwardRenewals = vi.fn(async () => {
        throw failure;
      });
    } else {
      deps.runRetention = vi.fn(async () => {
        throw failure;
      });
    }

    await expect(runUsageMaintenance(deps)).rejects.toBe(failure);
    expect(deliverAlerts).not.toHaveBeenCalled();
  });

  it.each([
    new TypeError("alert implementation bug"),
    Object.assign(new Error("schema missing"), {
      code: "P2021",
      meta: { modelName: "ProviderAlertNotification" },
    }),
    Object.assign(new Error("channel state timeout"), {
      code: "P1008",
      meta: { modelName: "ProviderAlertChannelDelivery" },
    }),
  ])("keeps non-bookkeeping alert failures fatal", async (failure) => {
    const deliverAlerts = vi.fn(async () => {
      throw failure;
    });

    await expect(runUsageMaintenance(dependencies(deliverAlerts))).rejects.toBe(failure);

    const nextDeliverAlerts = vi.fn(async () => deliveredAlerts);
    const next = await runUsageMaintenance(dependencies(nextDeliverAlerts));
    expect(next.alerts.deferredError).toBeNull();
    expect(nextDeliverAlerts).toHaveBeenCalledOnce();
  });
});
