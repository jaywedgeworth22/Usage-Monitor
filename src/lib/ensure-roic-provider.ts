import { prisma } from "@/lib/prisma";

/**
 * Ensure a visible ROIC.ai catalog row exists so Overview/Settings can show it.
 * Blind / push-manual only — no poll; track cost via Subscription or ingest.
 */
export async function ensureRoicProviderSeeded(): Promise<void> {
  const existing = await prisma.provider.findFirst({
    where: {
      OR: [
        { name: { equals: "roic" } },
        { name: { equals: "ROIC" } },
        { name: { equals: "roic.ai" } },
        { name: { equals: "ROIC.ai" } },
      ],
    },
    select: { id: true },
  });
  if (existing) return;

  await prisma.provider.create({
    data: {
      name: "roic",
      displayName: "ROIC.ai",
      type: "builtin",
      category: "Market Data",
      isActive: true,
      // No poll API — daily is enough if someone re-enables probing later.
      refreshIntervalMin: 1440,
    },
  });
}
