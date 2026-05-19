#!/usr/bin/env ts-node
/**
 * Phase R: Billing plan seed
 *
 * Creates the Starter, Professional, and Enterprise subscription plans.
 * Idempotent — uses upsert by plan name.
 *
 * Usage:
 *   DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/seed-billing-plans.ts
 */

import { PrismaClient } from "@prisma/client";

interface PlanSeed {
  name: string;
  displayName: string;
  stripePriceId: string | null;
  pricePerMonth: string;
  pricePerLocation: string;
  maxLocations: number | null;
  maxUsers: number | null;
  features: string[];
  isActive: boolean;
}

const PLANS: PlanSeed[] = [
  {
    name: "STARTER",
    displayName: "Starter",
    stripePriceId: process.env.STRIPE_PRICE_STARTER ?? null,
    pricePerMonth: "49.00",
    pricePerLocation: "0.00",
    maxLocations: 1,
    maxUsers: 5,
    features: [
      "orders",
      "kds",
      "printers",
      "uber_eats",
      "deliveroo",
      "cashier",
      "dispatch",
    ],
    isActive: true,
  },
  {
    name: "PROFESSIONAL",
    displayName: "Professional",
    stripePriceId: process.env.STRIPE_PRICE_PROFESSIONAL ?? null,
    pricePerMonth: "149.00",
    pricePerLocation: "0.00",
    maxLocations: 3,
    maxUsers: 20,
    features: [
      "orders",
      "kds",
      "printers",
      "uber_eats",
      "deliveroo",
      "just_eat",
      "hubriser",
      "cashier",
      "dispatch",
      "analytics",
      "rush_hour",
      "multi_location",
    ],
    isActive: true,
  },
  {
    name: "ENTERPRISE",
    displayName: "Enterprise",
    stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE ?? null,
    pricePerMonth: "0.00",
    pricePerLocation: "0.00",
    maxLocations: null,
    maxUsers: null,
    features: [
      "orders",
      "kds",
      "printers",
      "uber_eats",
      "deliveroo",
      "just_eat",
      "hubrise",
      "cashier",
      "dispatch",
      "analytics",
      "rush_hour",
      "multi_location",
      "custom_integrations",
      "sla_support",
      "white_label",
    ],
    isActive: true,
  },
];

async function main() {
  const prisma = new PrismaClient();
  const db = prisma as any;

  try {
    console.log("\nPhase R: Seeding billing plans...\n");

    for (const plan of PLANS) {
      const result = await db.subscriptionPlan.upsert({
        where: { name: plan.name },
        create: {
          name: plan.name,
          displayName: plan.displayName,
          stripePriceId: plan.stripePriceId,
          pricePerMonth: plan.pricePerMonth,
          pricePerLocation: plan.pricePerLocation,
          maxLocations: plan.maxLocations,
          maxUsers: plan.maxUsers,
          features: plan.features,
          isActive: plan.isActive,
        },
        update: {
          displayName: plan.displayName,
          pricePerMonth: plan.pricePerMonth,
          pricePerLocation: plan.pricePerLocation,
          maxLocations: plan.maxLocations,
          maxUsers: plan.maxUsers,
          features: plan.features,
          isActive: plan.isActive,
          // Do NOT overwrite stripePriceId if already set in prod
          ...(plan.stripePriceId ? { stripePriceId: plan.stripePriceId } : {}),
        },
      });
      console.log(
        `  ${result.name} (${result.displayName}): £${result.pricePerMonth}/month — id=${result.id}`,
      );
    }

    console.log("\nDone.\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
