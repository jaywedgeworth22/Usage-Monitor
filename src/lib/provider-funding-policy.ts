import { prisma } from "@/lib/prisma";
import { isLlmProviderName } from "@/lib/provider-definitions";

/**
 * Fleet policy: no LLM/AI provider may demand funding. All chat inference
 * routes through OpenRouter, so no direct LLM vendor (Anthropic, OpenAI,
 * DeepSeek, ...) is a hard production dependency and none may set
 * ProviderPlan.mustKeepFunded. This boot-time reconciliation (same pattern
 * and callsite as deactivateDecommissionedBuiltInProviders in
 * src/instrumentation.ts) clears any flag that predates the policy; the PUT
 * /api/providers/[id] handler rejects attempts to re-add it.
 *
 * Returns the number of providers whose flag was cleared.
 */
export async function clearLlmMustKeepFundedFlags(): Promise<number> {
  const flaggedPlans = await prisma.providerPlan.findMany({
    where: { mustKeepFunded: true },
    select: {
      providerId: true,
      provider: { select: { name: true, displayName: true } },
    },
  });
  const targets = flaggedPlans.filter((plan) =>
    isLlmProviderName(plan.provider.name)
  );
  if (targets.length === 0) return 0;

  let cleared = 0;
  for (const target of targets) {
    // Clearing the flag changes the evaluated alert set without a new
    // snapshot, so bump the provider's alert revision in the same transaction
    // (mirroring how PUT /api/providers/[id] pairs plan edits with
    // alertConfigGeneration increments).
    const clearedCount = await prisma.$transaction(async (tx) => {
      const updated = await tx.providerPlan.updateMany({
        where: { providerId: target.providerId, mustKeepFunded: true },
        data: { mustKeepFunded: false },
      });
      if (updated.count > 0) {
        await tx.provider.update({
          where: { id: target.providerId },
          data: { alertConfigGeneration: { increment: 1 } },
        });
      }
      return updated.count;
    });
    if (clearedCount === 0) continue;
    cleared += 1;
    console.info(
      `[funding-policy] cleared mustKeepFunded on LLM provider ${target.provider.name} (${target.provider.displayName}) — LLM vendors are reached via OpenRouter and must not demand funding`
    );
  }
  return cleared;
}
