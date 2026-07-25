#!/usr/bin/env node
/**
 * Import/seed user billing receipts, lifetime app purchases, and subscription updates.
 *
 * Updates & Additions:
 *   1. Unusual Whales: Weekly cost ($50/wk), canceled/expires July 30, 2026 (autoRenew: false)
 *   2. GitHub: $4.00/mo subscription
 *   3. Massive & FMP: Status "considering" (not renewed, autoRenew: false)
 *   4. Lifetime One-Time App/License Purchases:
 *      - Pushover License ($5.35, 2026-07-23)
 *      - Devly ($4.99, 2026-07-10)
 *      - OpenMark ($9.99, 2026-07-10)
 *      - App Explorer ($0.99, 2026-07-10)
 *      - KeyNest Pro ($1.99, 2026-07-10)
 *      - Parall ($10.71, 2026-07-05)
 *   5. Apple In-App Purchase Receipts & Tier Proration Refunds:
 *      - Claude Pro Monthly (Jun 13: +$21.45, Jun 16 refund: -$18.59)
 *      - HTML Pro (Jun 14: +$3.99)
 *      - Claude Max 5x (Jun 16: +$134.34, Jun 20 refund: -$116.17)
 *      - SuperGrok (Jun 18: +$32.18)
 *      - ChatGPT Pro 5x (Jun 18: +$107.25, Jun 22 refund: -$92.95)
 *      - Claude Max 20x (Jun 20: +$268.11)
 *      - ChatGPT Pro 20x (Jun 22: +$214.50)
 *
 * Usage:
 *   node scripts/add-user-billing-receipts.mjs
 */

import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const prisma = new PrismaClient();

function log(message) {
  console.log(`[add-user-receipts] ${message}`);
}

function deriveKey(provider, label, occurredAtIso) {
  return crypto
    .createHash("sha256")
    .update(`manual-receipt:${provider}:${label}:${occurredAtIso}`)
    .digest("hex");
}

const EVENTS = [
  // --- Lifetime App Purchases ---
  {
    providerName: "pushover",
    providerDisplayName: "Pushover",
    category: "App License",
    metricType: "one_time_license",
    amountUsd: 5.35,
    occurredAt: new Date(Date.UTC(2026, 6, 23, 12, 0, 0)),
    label: "Pushover License ($5.35 lifetime purchase)",
    externalId: "app-pushover-license-20260723",
  },
  {
    providerName: "devly",
    providerDisplayName: "Devly",
    category: "Developer Tools",
    metricType: "app_purchase",
    amountUsd: 4.99,
    occurredAt: new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
    label: "Devly App ($4.99 purchase)",
    externalId: "app-devly-20260710",
  },
  {
    providerName: "openmark",
    providerDisplayName: "OpenMark",
    category: "Developer Tools",
    metricType: "app_purchase",
    amountUsd: 9.99,
    occurredAt: new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
    label: "OpenMark App ($9.99 purchase)",
    externalId: "app-openmark-20260710",
  },
  {
    providerName: "app-explorer",
    providerDisplayName: "App Explorer",
    category: "Developer Tools",
    metricType: "app_purchase",
    amountUsd: 0.99,
    occurredAt: new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
    label: "App Explorer: Homebrew Catalog ($0.99 purchase)",
    externalId: "app-appexplorer-20260710",
  },
  {
    providerName: "keynest-pro",
    providerDisplayName: "KeyNest Pro",
    category: "Developer Tools",
    metricType: "app_purchase",
    amountUsd: 1.99,
    occurredAt: new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
    label: "KeyNest Pro In-App Purchase ($1.99)",
    externalId: "app-keynestpro-20260710",
  },
  {
    providerName: "parall",
    providerDisplayName: "Parall",
    category: "Developer Tools",
    metricType: "app_purchase",
    amountUsd: 10.71,
    occurredAt: new Date(Date.UTC(2026, 6, 5, 12, 0, 0)),
    label: "Parall App ($10.71 purchase w/ tax)",
    externalId: "app-parall-20260705",
  },

  // --- Prior Screenshots ---
  {
    providerName: "voyageai",
    providerDisplayName: "Voyage AI",
    category: "AI / Embeddings",
    metricType: "credit_purchase",
    amountUsd: 5.00,
    occurredAt: new Date(Date.UTC(2026, 5, 29, 12, 0, 0)),
    label: "Voyage AI $5.00 deposit receipt",
    externalId: "receipt-voyageai-20260629-500",
  },
  {
    providerName: "github",
    providerDisplayName: "GitHub",
    category: "Developer Platform",
    metricType: "subscription",
    amountUsd: 4.23,
    occurredAt: new Date(Date.UTC(2026, 5, 21, 12, 0, 0)),
    label: "GitHub $4.23 service charge receipt",
    externalId: "receipt-github-20260621-423",
  },
  {
    providerName: "unusual-whales",
    providerDisplayName: "Unusual Whales",
    category: "Financial Data",
    metricType: "subscription",
    amountUsd: 50.00,
    occurredAt: new Date(Date.UTC(2026, 6, 23, 0, 34, 0)),
    label: "Unusual Whales, Inc. $50.00 weekly receipt",
    externalId: "receipt-unusualwhales-20260723-5000",
  },
  {
    providerName: "massive",
    providerDisplayName: "Massive.com",
    category: "Financial Data",
    metricType: "subscription",
    amountUsd: 29.29,
    occurredAt: new Date(Date.UTC(2026, 5, 22, 21, 11, 1)),
    label: "MASSIVE.COM DATA API $29.29 charge receipt",
    externalId: "receipt-massive-20260622-2929",
  },
  {
    providerName: "fmp",
    providerDisplayName: "Financial Modeling Prep",
    category: "Financial Data",
    metricType: "subscription",
    amountUsd: 32.22,
    occurredAt: new Date(Date.UTC(2026, 5, 22, 13, 1, 0)),
    label: "FINANCIALMODELINGPREP $32.22 charge receipt",
    externalId: "receipt-fmp-20260622-3222",
  },
  {
    providerName: "mistral",
    providerDisplayName: "Mistral AI",
    category: "AI / LLM",
    metricType: "credit_purchase",
    amountUsd: 10.10,
    occurredAt: new Date(Date.UTC(2026, 5, 25, 10, 20, 36)),
    label: "MISTRAL AI INC $10.10 deposit receipt",
    externalId: "receipt-mistral-20260625-1010",
  },
  {
    providerName: "cloudflare",
    providerDisplayName: "Cloudflare",
    category: "Infrastructure",
    metricType: "subscription",
    amountUsd: 3.95,
    occurredAt: new Date(Date.UTC(2026, 5, 24, 17, 12, 51)),
    label: "CLOUDFLARE $3.95 charge receipt",
    externalId: "receipt-cloudflare-20260624-395",
  },

  // --- Apple In-App Purchase Receipts & Refunds ---
  {
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: 21.45,
    occurredAt: new Date(Date.UTC(2026, 5, 13, 19, 10, 0)),
    label: "Claude Pro Monthly (Apple receipt MNDF4M2N32)",
    externalId: "apple-receipt-2026-06-13-claude-pro",
  },
  {
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: -18.59,
    occurredAt: new Date(Date.UTC(2026, 5, 16, 12, 0, 0)),
    label: "Claude Pro Monthly Prorated Refund (Apple receipt MNDF4M2N32)",
    externalId: "apple-refund-2026-06-16-claude-pro",
  },
  {
    providerName: "html-pro",
    providerDisplayName: "HTML Pro",
    category: "Developer Tools",
    metricType: "subscription",
    amountUsd: 3.99,
    occurredAt: new Date(Date.UTC(2026, 5, 14, 0, 43, 0)),
    label: "HTML Pro Subscription Resubscribed (Apple receipt MNDF4VLSNX)",
    externalId: "apple-receipt-2026-06-14-html-pro",
  },
  {
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: 134.34, // $124.99 + prorated tax
    occurredAt: new Date(Date.UTC(2026, 5, 16, 17, 18, 0)),
    label: "Claude Max 5x Monthly (Apple receipt MNDF4VLSNX)",
    externalId: "apple-receipt-2026-06-16-claude-max-5x",
  },
  {
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: -116.17,
    occurredAt: new Date(Date.UTC(2026, 5, 20, 12, 0, 0)),
    label: "Claude Max 5x Monthly Prorated Refund (Apple receipt MNDF4VLSNX)",
    externalId: "apple-refund-2026-06-20-claude-max-5x",
  },
  {
    providerName: "xai",
    providerDisplayName: "xAI / Grok",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: 32.18, // $30.00 + tax
    occurredAt: new Date(Date.UTC(2026, 5, 18, 10, 43, 0)),
    label: "SuperGrok Subscription Resubscribed (Apple receipt MNDF570KM5)",
    externalId: "apple-receipt-2026-06-18-supergrok",
  },
  {
    providerName: "openai",
    providerDisplayName: "OpenAI",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: 107.25, // $100.00 + tax
    occurredAt: new Date(Date.UTC(2026, 5, 18, 18, 55, 0)),
    label: "ChatGPT Pro 5x Subscription Resubscribed (Apple receipt MNDF570KM5)",
    externalId: "apple-receipt-2026-06-18-chatgpt-pro-5x",
  },
  {
    providerName: "openai",
    providerDisplayName: "OpenAI",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: -92.95,
    occurredAt: new Date(Date.UTC(2026, 5, 22, 12, 0, 0)),
    label: "ChatGPT Pro 5x Prorated Refund (Apple receipt MNDF570KM5)",
    externalId: "apple-refund-2026-06-22-chatgpt-pro-5x",
  },
  {
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: 268.11, // $249.99 + tax
    occurredAt: new Date(Date.UTC(2026, 5, 20, 12, 0, 0)),
    label: "Claude Max 20x Monthly Subscription",
    externalId: "apple-receipt-2026-06-20-claude-max-20x",
  },
  {
    providerName: "openai",
    providerDisplayName: "OpenAI",
    category: "AI / LLM",
    metricType: "subscription",
    amountUsd: 214.50, // $200.00 + tax
    occurredAt: new Date(Date.UTC(2026, 5, 22, 12, 0, 0)),
    label: "ChatGPT Pro 20x Monthly Subscription",
    externalId: "apple-receipt-2026-06-22-chatgpt-pro-20x",
  },
];

async function main() {
  const allProviders = await prisma.provider.findMany();

  // Helper to ensure provider exists
  async function ensureProvider(name, displayName, category) {
    let p = allProviders.find(
      (item) =>
        item.name.toLowerCase() === name.toLowerCase() ||
        item.displayName.toLowerCase() === displayName.toLowerCase()
    );
    if (!p) {
      log(`Creating Provider row for ${displayName}...`);
      p = await prisma.provider.create({
        data: {
          name,
          displayName,
          type: "generic",
          category: category || "General Services",
          isActive: true,
        },
      });
      allProviders.push(p);
    }
    return p;
  }

  // --- 1. Import all Events ---
  for (const item of EVENTS) {
    const provider = await ensureProvider(
      item.providerName,
      item.providerDisplayName,
      item.category
    );

    const key = deriveKey(item.providerName, item.label, item.occurredAt.toISOString());
    const existing = await prisma.externalUsageEvent.findUnique({
      where: { idempotencyKey: key },
    });

    if (existing) {
      log(`Event "${item.label}" already recorded. Skipping.`);
    } else {
      const created = await prisma.externalUsageEvent.create({
        data: {
          idempotencyKey: key,
          sourceApp: "manual-receipt-import",
          provider: item.providerName,
          label: item.label,
          billingMode: "actual",
          metricType: item.metricType,
          costUsd: item.amountUsd,
          confidence: "actual",
          occurredAt: item.occurredAt,
          metadata: {
            externalId: item.externalId,
            importedAt: new Date().toISOString(),
          },
        },
      });
      log(`Recorded event for ${item.providerDisplayName}: $${item.amountUsd} (id=${created.id})`);
    }
  }

  // --- 2. Update Subscription Rows according to user directives ---

  // Unusual Whales: Weekly cost ($50/wk), expires July 30, 2026, canceled (autoRenew: false)
  const uwProvider = await ensureProvider("unusual-whales", "Unusual Whales", "Financial Data");
  const existingUwSub = await prisma.subscription.findFirst({
    where: { providerId: uwProvider.id, name: { contains: "Unusual Whales" } },
  });
  if (existingUwSub) {
    log(`Updating Unusual Whales subscription to Weekly ($50/wk), expiring July 30 (canceled)...`);
    await prisma.subscription.update({
      where: { id: existingUwSub.id },
      data: {
        interval: "weekly",
        intervalCount: 1,
        costUsd: 50.00,
        nextRenewalAt: new Date(Date.UTC(2026, 6, 30)), // July 30, 2026
        autoRenew: false,
        status: "canceled",
        notes: "Unusual Whales weekly subscription. Expires July 30, 2026; will not renew.",
      },
    });
  }

  // GitHub: $4.00 monthly subscription
  const ghProvider = await ensureProvider("github", "GitHub", "Developer Platform");
  const existingGhSub = await prisma.subscription.findFirst({
    where: { providerId: ghProvider.id, name: { contains: "GitHub" } },
  });
  if (existingGhSub) {
    log(`Updating GitHub subscription to $4.00/mo...`);
    await prisma.subscription.update({
      where: { id: existingGhSub.id },
      data: {
        costUsd: 4.00,
        interval: "monthly",
        status: "active",
        notes: "GitHub Pro $4/mo monthly subscription.",
      },
    });
  } else {
    log(`Creating GitHub Pro subscription ($4.00/mo)...`);
    await prisma.subscription.create({
      data: {
        providerId: ghProvider.id,
        name: "GitHub Pro",
        costUsd: 4.00,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date(Date.UTC(2026, 5, 21)),
        currentPeriodStart: new Date(Date.UTC(2026, 5, 21)),
        nextRenewalAt: new Date(Date.UTC(2026, 6, 21)),
        autoRenew: true,
        status: "active",
        notes: "GitHub Pro $4/mo monthly subscription.",
        knobEnv: {},
      },
    });
  }

  // Massive.com: Status "considering" (not renewed)
  const massiveProvider = await ensureProvider("massive", "Massive.com", "Financial Data");
  const existingMassiveSub = await prisma.subscription.findFirst({
    where: { providerId: massiveProvider.id },
  });
  if (existingMassiveSub) {
    log(`Setting Massive.com subscription to considering (not renewed)...`);
    await prisma.subscription.update({
      where: { id: existingMassiveSub.id },
      data: {
        status: "considering",
        autoRenew: false,
        notes: "Massive.com Data API - decided not yet to renew.",
      },
    });
  }

  // Financial Modeling Prep (FMP): Status "considering" (not renewed)
  const fmpProvider = await ensureProvider("fmp", "Financial Modeling Prep", "Financial Data");
  const existingFmpSub = await prisma.subscription.findFirst({
    where: { providerId: fmpProvider.id },
  });
  if (existingFmpSub) {
    log(`Setting FMP subscription to considering (not renewed)...`);
    await prisma.subscription.update({
      where: { id: existingFmpSub.id },
      data: {
        status: "considering",
        autoRenew: false,
        notes: "FMP Data API - decided not yet to renew.",
      },
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
