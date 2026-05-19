#!/usr/bin/env ts-node
/**
 * Phase R: Pilot shop migration script
 *
 * Marks all 5 Phase Q pilot shops as FREE_PILOT with trialEndsAt = 2026-09-01.
 * Safe to run multiple times (idempotent).
 *
 * Usage:
 *   DRY_RUN=true DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/migrate-pilot-shops.ts
 */

import { PrismaClient } from "@prisma/client";

const FREE_PILOT_ENDS_AT = new Date("2026-09-01T00:00:00.000Z");
const STARTER_PLAN_NAME = "STARTER";

// The 5 Phase Q shops — identified by shopCode assigned during rollout
const PILOT_SHOP_CODES = ["SHOP01", "SHOP02", "SHOP03", "SHOP04", "SHOP05"];

async function main() {
  const dryRun = process.env.DRY_RUN === "true";
  const prisma = new PrismaClient();
  const db = prisma as any;

  try {
    console.log(`\nPhase R: Pilot shop FREE_PILOT migration ${dryRun ? "(DRY RUN)" : ""}`);
    console.log(`Free pilot ends: ${FREE_PILOT_ENDS_AT.toISOString()}\n`);

    // Resolve locations by shopCode
    const locations = await db.location.findMany({
      where: { shopCode: { in: PILOT_SHOP_CODES } },
      include: {
        brand: {
          include: {
            tenant: {
              include: { subscription: { include: { plan: true } } },
            },
          },
        },
      },
    });

    if (locations.length === 0) {
      console.log("No pilot locations found. Check shopCode values.");
      return;
    }

    // Resolve starter plan
    const starterPlan = await db.subscriptionPlan.findUnique({
      where: { name: STARTER_PLAN_NAME },
    });

    if (!starterPlan) {
      console.error(`ERROR: SubscriptionPlan '${STARTER_PLAN_NAME}' not found. Run plan seed first.`);
      process.exit(1);
    }

    let migrated = 0;
    let alreadyMigrated = 0;
    let errors = 0;

    for (const loc of locations) {
      const tenant = loc.brand?.tenant;
      if (!tenant) {
        console.warn(`  WARN: Location ${loc.shopCode} has no tenant — skipping`);
        continue;
      }

      const sub = tenant.subscription;
      const tenantId = tenant.id;

      if (sub?.status === "FREE_PILOT") {
        console.log(`  SKIP ${loc.shopCode} (${tenant.name}): already FREE_PILOT`);
        alreadyMigrated++;
        continue;
      }

      const action = sub ? "UPDATE" : "CREATE";
      console.log(
        `  ${dryRun ? "[DRY] " : ""}${action} ${loc.shopCode} (${tenant.name}) → FREE_PILOT until ${FREE_PILOT_ENDS_AT.toISOString().slice(0, 10)}`,
      );

      if (!dryRun) {
        try {
          if (sub) {
            await db.tenantSubscription.update({
              where: { tenantId },
              data: {
                status: "FREE_PILOT",
                trialEndsAt: FREE_PILOT_ENDS_AT,
                cancelAtPeriodEnd: false,
                metadata: {
                  ...(sub.metadata ?? {}),
                  migratedToFreePilot: new Date().toISOString(),
                  originalStatus: sub.status,
                  phaseQShopCode: loc.shopCode,
                },
              },
            });
          } else {
            const now = new Date();
            const periodEnd = new Date(now);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            await db.tenantSubscription.create({
              data: {
                tenantId,
                planId: starterPlan.id,
                status: "FREE_PILOT",
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                trialEndsAt: FREE_PILOT_ENDS_AT,
                cancelAtPeriodEnd: false,
                locationCount: 1,
                metadata: {
                  migratedToFreePilot: new Date().toISOString(),
                  phaseQShopCode: loc.shopCode,
                },
              },
            });
          }
          migrated++;
        } catch (err) {
          console.error(`  ERROR migrating ${loc.shopCode}: ${err}`);
          errors++;
        }
      } else {
        migrated++;
      }
    }

    console.log(`\nSummary:`);
    console.log(`  Migrated:         ${migrated}`);
    console.log(`  Already migrated: ${alreadyMigrated}`);
    if (errors > 0) console.log(`  Errors:           ${errors}`);
    if (dryRun) console.log(`\nDry run complete — no changes made. Re-run without DRY_RUN=true to apply.`);
    else console.log(`\nMigration complete.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
