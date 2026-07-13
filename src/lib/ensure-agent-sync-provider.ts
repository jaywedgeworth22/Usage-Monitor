import { prisma } from "@/lib/prisma";

export async function ensureAgentSyncProviderSeeded(): Promise<void> {
  const providers = await prisma.provider.findMany({ select: { id: true, name: true, isActive: true } });
  
  // 1. Disable Agent Sync Relay to stop "missing_snapshot" noise
  const relay = providers.find((p) => p.name.toLowerCase() === "agent-sync-relay");
  if (relay) {
    if (relay.isActive) {
      await prisma.provider.update({
        where: { id: relay.id },
        data: { isActive: false },
      });
    }
  } else {
    await prisma.provider.create({
      data: {
        name: "agent-sync-relay",
        displayName: "Agent Sync Relay",
        type: "builtin",
        isActive: false, // disabled to stop noise
        refreshIntervalMin: 15,
      },
    });
  }

  // 2. Fix Anthropic 'mustKeepFunded' misconfiguration to stop balance visibility alerts
  const anthropic = providers.find((p) => p.name.toLowerCase() === "anthropic");
  if (anthropic) {
    const plan = await prisma.providerPlan.findUnique({ where: { providerId: anthropic.id } });
    if (plan?.mustKeepFunded) {
      await prisma.providerPlan.update({
        where: { providerId: anthropic.id },
        data: { mustKeepFunded: false },
      });
    }
  }
}
