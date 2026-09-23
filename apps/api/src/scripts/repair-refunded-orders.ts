/**
 * Repair orders that a provider webhook re-settled AFTER they were refunded.
 *
 * Until 5d7afe5c, `settleCardPresentPayment` only treated SUCCEEDED as
 * "already banked". A FULL refund leaves the Payment row REFUNDED, so a
 * routine webhook arriving after the refund rewrote the row to SUCCEEDED and
 * the Order to PAID — the board then showed money the shop had given back.
 * (Dojo, order cmue9c1i…, 2026-09-23: refund done 15:53:40, re-settled
 * 15:53:42.) The guard stops it happening again; this fixes what it already
 * did.
 *
 * The Refund rows are the truth: they are only ever written when a provider
 * confirmed the money moved. So this recomputes each order's payment state
 * from its refunds and corrects anything that disagrees. Nothing is invented —
 * an order with no refunds is never touched, and money is only ever marked as
 * returned, never as taken.
 *
 * Safe to re-run: a second pass finds nothing to do.
 *
 * Dry-run (prints what it WOULD change, writes nothing):
 *   DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/repair-refunded-orders.ts
 *
 * Apply:
 *   APPLY=true DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/repair-refunded-orders.ts
 *
 * One order only (recommended when you know which):
 *   ORDER_ID=cmue9c1i5000q556cf0fms4yq APPLY=true DATABASE_URL=<url> …
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();
const APPLY = process.env["APPLY"] === "true";
const ONLY_ORDER = process.env["ORDER_ID"]?.trim() || null;

const minor = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const money = (m: number) => `£${(m / 100).toFixed(2)}`;

async function main() {
  // Every payment that has a confirmed refund against it.
  const refunds = await (prisma as any).refund.findMany({
    where: { status: "SUCCEEDED" },
    select: { paymentId: true, amount: true },
  });
  const refundedByPayment = new Map<string, number>();
  for (const r of refunds) {
    refundedByPayment.set(r.paymentId, (refundedByPayment.get(r.paymentId) ?? 0) + minor(r.amount));
  }
  if (refundedByPayment.size === 0) {
    console.log("No refunds on record — nothing to repair.");
    return;
  }

  const payments = await (prisma as any).payment.findMany({
    where: {
      id: { in: [...refundedByPayment.keys()] },
      ...(ONLY_ORDER ? { orderId: ONLY_ORDER } : {}),
    },
    select: { id: true, orderId: true, amount: true, status: true, provider: true },
  });

  const byOrder = new Map<string, any[]>();
  for (const p of payments) {
    if (!p.orderId) continue;
    byOrder.set(p.orderId, [...(byOrder.get(p.orderId) ?? []), p]);
  }

  let checked = 0;
  let fixed = 0;
  for (const [orderId, rows] of byOrder) {
    checked++;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, displayId: true, paymentStatus: true },
    });
    if (!order) continue;

    // Sum across EVERY payment on the order, not just the refunded ones: a
    // split bill's other halves are still the shop's money.
    const all = await (prisma as any).payment.findMany({
      where: { orderId, status: { in: ["SUCCEEDED", "REFUNDED"] } },
      select: { id: true, amount: true },
    });
    const takenMinor = all.reduce((s: number, p: any) => s + minor(p.amount), 0);
    const refundedMinor = all.reduce((s: number, p: any) => s + (refundedByPayment.get(p.id) ?? 0), 0);
    if (refundedMinor <= 0) continue;

    const wantOrder = refundedMinor >= takenMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const changes: string[] = [];

    // A payment row whose whole amount went back must not read SUCCEEDED.
    for (const p of rows) {
      const back = refundedByPayment.get(p.id) ?? 0;
      if (back >= minor(p.amount) && p.status !== "REFUNDED") {
        changes.push(`payment ${p.id} ${p.status} → REFUNDED (${money(back)} of ${money(minor(p.amount))})`);
        if (APPLY) {
          await (prisma as any).payment.update({ where: { id: p.id }, data: { status: "REFUNDED" } });
        }
      }
    }
    if (order.paymentStatus !== wantOrder) {
      changes.push(
        `order ${order.displayId ?? orderId} ${order.paymentStatus} → ${wantOrder} ` +
          `(${money(refundedMinor)} back of ${money(takenMinor)})`,
      );
      if (APPLY) {
        await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: wantOrder as any } });
      }
    }

    if (changes.length) {
      fixed++;
      console.log(`${APPLY ? "FIXED" : "WOULD FIX"} ${orderId}:`);
      for (const c of changes) console.log(`   ${c}`);
    }
  }

  console.log(
    `\n${checked} refunded order(s) checked, ${fixed} needed repair.` +
      (APPLY || fixed === 0 ? "" : " Re-run with APPLY=true to write."),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
