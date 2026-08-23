#!/usr/bin/env ts-node
/**
 * Which billing system is real, and who is billed but not enforceable?
 *
 * There are two complete subscription systems in this codebase and only one of
 * them gates access:
 *
 *   • MerchantSubscription (modules/subscriptions, /dashboard/subscription) —
 *     per LOCATION, Stripe Checkout, the newer of the two and the only one in
 *     the sidebar. TAKES THE MONEY.
 *   • TenantSubscription (modules/billing, /dashboard/billing) — per TENANT,
 *     plans + invoices + usage limits, from the earlier Phase F work.
 *     BillingGuard reads THIS ONE, and nothing else.
 *
 * BillingGuard is registered globally (app.module.ts) and returns `true` when a
 * tenant has no TenantSubscription row. So any tenant billed through the newer
 * per-location flow, with no TenantSubscription, keeps full access no matter
 * what their card does.
 *
 * This script only reads. It changes nothing, and it is safe to run against
 * production.
 *
 * Usage:
 *   DATABASE_URL=<prod-url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/diagnose-billing-enforcement.ts
 */

import { PrismaClient } from "@orderhub/database";

/** MerchantSubscription statuses that mean "this shop is on the hook to pay" —
 *  Stripe's own vocabulary, lowercase. `incomplete` and `canceled` are excluded
 *  deliberately: neither is a live billing relationship. */
const LIVE_MERCHANT_STATUSES = ["active", "past_due", "trialing", "unpaid"];

const db = new PrismaClient();

const pct = (n: number, of: number) =>
  of === 0 ? "—" : `${Math.round((n / of) * 100)}%`;

async function main() {
  const line = (s = "") => console.log(s);
  const rule = () => line("─".repeat(72));

  line();
  line("BILLING ENFORCEMENT DIAGNOSTIC");
  rule();

  // ── 1. Does the older system have any plans at all? ──────────────────────
  // TenantSubscription.planId is a required FK to SubscriptionPlan. If nothing
  // seeded the plans, no TenantSubscription can exist, and the guard can never
  // fire for anyone.
  const planCount = await db.subscriptionPlan.count();
  line();
  line(`SubscriptionPlan rows (needed by the ENFORCED system): ${planCount}`);
  if (planCount === 0) {
    line("  → none seeded, so no TenantSubscription can exist at all,");
    line("    so BillingGuard currently cannot block anybody.");
  }

  // ── 2. Population of each system ─────────────────────────────────────────
  const merchantByStatus = await db.merchantSubscription.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const tenantByStatus = await db.tenantSubscription.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  line();
  line("MerchantSubscription — TAKES THE MONEY, not read by the guard");
  rule();
  if (merchantByStatus.length === 0) line("  (no rows)");
  for (const r of merchantByStatus) {
    line(`  ${String(r.status).padEnd(14)} ${r._count._all}`);
  }

  line();
  line("TenantSubscription — READ BY THE GUARD");
  rule();
  if (tenantByStatus.length === 0) line("  (no rows)");
  for (const r of tenantByStatus) {
    line(`  ${String(r.status).padEnd(14)} ${r._count._all}`);
  }

  // ── 3. The number that actually matters ──────────────────────────────────
  // Tenants with a live per-location subscription and NO tenant-level row.
  // Every one of these can stop paying and keep trading.
  const liveMerchant = await db.merchantSubscription.findMany({
    where: { status: { in: LIVE_MERCHANT_STATUSES } },
    select: {
      tenantId: true,
      locationId: true,
      status: true,
      monthlyAmountPence: true,
      currency: true,
      location: { select: { name: true, country: true } },
    },
  });

  const tenantIdsWithTenantSub = new Set(
    (
      await db.tenantSubscription.findMany({ select: { tenantId: true } })
    ).map((t) => t.tenantId),
  );

  const exposed = liveMerchant.filter(
    (m) => !tenantIdsWithTenantSub.has(m.tenantId),
  );
  const covered = liveMerchant.length - exposed.length;

  line();
  line("BILLED BUT NOT ENFORCEABLE");
  rule();
  line(`  Live per-location subscriptions:      ${liveMerchant.length}`);
  line(
    `  ...with a tenant row (guard applies): ${covered} ${pct(covered, liveMerchant.length)}`,
  );
  line(
    `  ...WITHOUT one (guard never fires):   ${exposed.length} ${pct(exposed.length, liveMerchant.length)}`,
  );

  if (exposed.length) {
    const monthly = exposed.reduce((s, m) => s + (m.monthlyAmountPence ?? 0), 0);
    line();
    line(
      `  Monthly value with no enforcement behind it: ${(monthly / 100).toFixed(2)} ` +
        `(${[...new Set(exposed.map((e) => e.currency))].join("/")})`,
    );
    line();
    line("  Locations:");
    for (const m of exposed.slice(0, 25)) {
      line(
        `    ${String(m.location?.name ?? m.locationId).slice(0, 34).padEnd(36)} ` +
          `${String(m.location?.country ?? "??").padEnd(4)} ${m.status}`,
      );
    }
    if (exposed.length > 25) line(`    …and ${exposed.length - 25} more`);
  }

  // ── 4. Anyone already failing to pay ─────────────────────────────────────
  // The ones where it isn't theoretical: their card has already failed.
  const failing = liveMerchant.filter((m) =>
    ["past_due", "unpaid"].includes(m.status),
  );
  line();
  line("ALREADY FAILING TO PAY");
  rule();
  if (failing.length === 0) {
    line("  None — nobody is currently past_due or unpaid.");
  } else {
    for (const m of failing) {
      const enforced = tenantIdsWithTenantSub.has(m.tenantId);
      line(
        `  ${String(m.location?.name ?? m.locationId).slice(0, 34).padEnd(36)} ` +
          `${m.status.padEnd(9)} ${enforced ? "restricted" : "STILL HAS FULL ACCESS"}`,
      );
    }
  }

  line();
  rule();
  line("Read-only. Nothing was changed.");
  line();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
