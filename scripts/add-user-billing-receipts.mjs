#!/usr/bin/env node
/**
 * Import/seed user billing receipts and subscriptions from recent receipt screenshots:
 *   1. Voyage AI ($5.00 deposit, 2026-06-29)
 *   2. GitHub ($4.23 charge, 2026-06-21)
 *   3. Unusual Whales, Inc. ($50.00 subscription/purchase, 2026-07-23)
 *   4. Massive.com Data API ($29.29 charge, 2026-06-22)
 *   5. Financial Modeling Prep / FMP ($32.22 charge, 2026-06-22)
 *   6. Mistral AI Inc ($10.10 deposit, 2026-06-25)
 *   7. Cloudflare ($3.95 charge, 2026-06-24)
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

// Derive a deterministic idempotency key for ExternalUsageEvent
function deriveKey(provider, label, occurredAtIso) {
  return crypto
    .createHash("sha256")
    .update(`manual-receipt:${provider}:${label}:${occurredAtIso}`)
    .digest("hex");
}

const RECEIPT_ITEMS = [
  {
    providerName: "voyageai",
    providerDisplayName: "Voyage AI",
    category: "AI / Embeddings",
    metricType: "credit_purchase",
    amountUsd: 5.00,
    occurredAt: new Date(Date.UTC(2026, 5, 29, 12, 0, 0)), // June 29, 2026
    label: "Voyage AI $5.00 deposit receipt",
    externalId: "receipt-voyageai-20260629-500",
  },
  {
    providerName: "github",
    providerDisplayName: "GitHub",
    category: "Developer Platform",
    metricType: "subscription",
    amountUsd: 4.23,
    occurredAt: new Date(Date.UTC(2026, 5, 21, 12, 0, 0)), // June 21, 2026
    label: "GitHub $4.23 service charge receipt",
    externalId: "receipt-github-20260621-423",
  },
  {
    providerName: "unusual-whales",
    providerDisplayName: "Unusual Whales",
    category: "Financial Data",
    metricType: "subscription",
    amountUsd: 50.00,
    occurredAt: new Date(Date.UTC(2026, 6, 23, 0, 34, 0)), // July 23, 2026 12:34 AM
    label: "Unusual Whales, Inc. $50.00 purchase receipt",
    externalId: "receipt-unusualwhales-20260723-5000",
    createSubscription: {
      name: "Unusual Whales Subscription",
      costUsd: 50.00,
      startDate: new Date(Date.UTC(2026, 6, 23)),
      currentPeriodStart: new Date(Date.UTC(2026, 6, 23)),
      nextRenewalAt: new Date(Date.UTC(2026, 7, 23)),
    },
  },
  {
    providerName: "massive",
    providerDisplayName: "Massive.com",
    category: "Financial Data",
    metricType: "subscription",
    amountUsd: 29.29,
    occurredAt: new Date(Date.UTC(2026, 5, 22, 21, 11, 1)), // June 22, 2026 21:11:01
    label: "MASSIVE.COM DATA API $29.29 charge receipt",
    externalId: "receipt-massive-20260622-2929",
  },
  {
    providerName: "fmp",
    providerDisplayName: "Financial Modeling Prep",
    category: "Financial Data",
    metricType: "subscription",
    amountUsd: 32.22,
    occurredAt: new Date(Date.UTC(2026, 5, 22, 13, 1, 0)), // June 22, 2026 13:01:00
    label: "FINANCIALMODELINGPREP $32.22 charge receipt",
    externalId: "receipt-fmp-20260622-3222",
  },
  {
    providerName: "mistral",
    providerDisplayName: "Mistral AI",
    category: "AI / LLM",
    metricType: "credit_purchase",
    amountUsd: 10.10,
    occurredAt: new Date(Date.UTC(2026, 5, 25, 10, 20, 36)), // June 25, 2026 10:20:36
    label: "MISTRAL AI INC $10.10 deposit receipt",
    externalId: "receipt-mistral-20260625-1010",
  },
  {
    providerName: "cloudflare",
    providerDisplayName: "Cloudflare",
    category: "Infrastructure",
    metricType: "subscription",
    amountUsd: 3.95,
    occurredAt: new Date(Date.UTC(2026, 5, 24, 17, 12, 51)), // June 24, 2026 17:12:51
    label: "CLOUDFLARE $3.95 charge receipt",
    externalId: "receipt-cloudflare-20260624-395",
  },
];

async function main() {
  const allProviders = await prisma.provider.findMany();

  for (const item of RECEIPT_ITEMS) {
    // Case-insensitive provider lookup
    let provider = allProviders.find(
      (p) =>
        p.name.toLowerCase() === item.providerName.toLowerCase() ||
        p.displayName.toLowerCase() === item.providerDisplayName.toLowerCase()
    );

    if (!provider) {
      log(`Creating Provider row for ${item.providerDisplayName}...`);
      provider = await prisma.provider.create({
        data: {
          name: item.providerName,
          displayName: item.providerDisplayName,
          type: "generic",
          category: item.category,
          isActive: true,
        },
      });
      allProviders.push(provider);
    }

    // 1. Check or insert ExternalUsageEvent
    const key = deriveKey(item.providerName, item.label, item.occurredAt.toISOString());
    const existingEvent = await prisma.externalUsageEvent.findUnique({
      where: { idempotencyKey: key },
    });

    if (existingEvent) {
      log(`Event "${item.label}" already recorded (id=${existingEvent.id}). Skipping.`);
    } else {
      const createdEvent = await prisma.externalUsageEvent.create({
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
      log(`Recorded event for ${item.providerDisplayName}: $${item.amountUsd} (id=${createdEvent.id})`);
    }

    // 2. Create Subscription if specified (e.g. Unusual Whales)
    if (item.createSubscription) {
      const existingSub = await prisma.subscription.findFirst({
        where: { providerId: provider.id, name: item.createSubscription.name },
      });
      if (!existingSub) {
        log(`Creating Subscription row "${item.createSubscription.name}" ($${item.createSubscription.costUsd}/mo)...`);
        await prisma.subscription.create({
          data: {
            providerId: provider.id,
            name: item.createSubscription.name,
            costUsd: item.createSubscription.costUsd,
            currency: "USD",
            interval: "monthly",
            intervalCount: 1,
            startDate: item.createSubscription.startDate,
            currentPeriodStart: item.createSubscription.currentPeriodStart,
            nextRenewalAt: item.createSubscription.nextRenewalAt,
            autoRenew: true,
            status: "active",
            notes: `${item.providerDisplayName} $${item.createSubscription.costUsd}/mo subscription from receipt.`,
            knobEnv: {},
          },
        });
      }
    }
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
