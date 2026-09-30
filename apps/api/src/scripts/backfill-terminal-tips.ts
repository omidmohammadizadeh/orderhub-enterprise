/**
 * Repair what an order forgot about the card machine that paid it: the tip
 * left on the terminal, and the fact that it was a card at all.
 *
 * Until 90fb2f12, a tip added by the customer ON the terminal was written to
 * the Payment row and stopped there — the order, the drawer and the printed
 * receipt all showed a bill with no tip on it. Dojo's Pay at Table
 * certification found it: on order cmuo62q1z…, 2026-09-30, three of five
 * splits carried a tip (0.59 + 0.73 + 0.88 = 2.20) and the order showed none
 * of it.
 *
 * This recomputes each affected order's tip from its OWN payment rows, which
 * are the truth — they are only written when the provider confirmed the money.
 * Nothing is invented, and `total` is never touched: the tip was paid on top
 * of the bill, and five separate places work out what a table still owes by
 * subtracting what's been paid from `total`.
 *
 * Safe to re-run: each payment is marked `tipAppliedToOrder` once, so a second
 * pass finds nothing to do.
 *
 * Dry-run (prints what it WOULD change, writes nothing):
 *   DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/backfill-terminal-tips.ts
 *
 * Apply:
 *   APPLY=true DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/backfill-terminal-tips.ts
 *
 * One order only:
 *   ORDER_ID=cmuo62q1z0133me4kwba1i0q4 APPLY=true DATABASE_URL=<url> …
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();
const APPLY = process.env["APPLY"] === "true";
const ONLY_ORDER = process.env["ORDER_ID"]?.trim() || null;

const minor = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const money = (m: number) => `£${(m / 100).toFixed(2)}`;

async function main() {
  // Card-present payments that carried a tip and haven't been folded into
  // their order yet. A refunded row still tipped at the time, so status is
  // deliberately not narrowed beyond "the money landed".
  const payments = await (prisma as any).payment.findMany({
    where: {
      tipAmount: { gt: 0 },
      status: { in: ["SUCCEEDED", "REFUNDED"] },
      ...(ONLY_ORDER ? { orderId: ONLY_ORDER } : {}),
    },
    select: { id: true, orderId: true, tipAmount: true, metadata: true, provider: true },
    orderBy: { createdAt: "asc" },
  });

  const pending = payments.filter((p: any) => !(p.metadata as any)?.tipAppliedToOrder);
  if (!pending.length) {
    console.log("Nothing to do — every card-machine tip is already on its order.");
    return;
  }

  const byOrder = new Map<string, any[]>();
  for (const p of pending) {
    if (!p.orderId) continue;
    byOrder.set(p.orderId, [...(byOrder.get(p.orderId) ?? []), p]);
  }

  console.log(`${pending.length} tipped payment(s) across ${byOrder.size} order(s)${APPLY ? "" : " — DRY RUN"}\n`);

  let changed = 0;
  for (const [orderId, rows] of byOrder) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, displayId: true, total: true, tipAmount: true, metadata: true },
    });
    if (!order) {
      console.log(`  ${orderId} — order is gone, skipping`);
      continue;
    }
    const addMinor = rows.reduce((s: number, p: any) => s + minor(p.tipAmount), 0);
    const meta = { ...((order.metadata as any) ?? {}) };
    const already = Number(meta.terminalTipsMinor ?? 0);

    console.log(
      `  ${order.displayId ?? order.id.slice(-8)} (${order.id}) — bill ${money(minor(order.total))}, ` +
        `tip ${money(minor(order.tipAmount))} → ${money(minor(order.tipAmount) + addMinor)} ` +
        `(+${money(addMinor)} from ${rows.length} payment(s) on the machine)`,
    );
    for (const p of rows) {
      console.log(`      ${p.provider} ${p.id}: ${money(minor(p.tipAmount))}`);
    }

    if (!APPLY) continue;
    meta.terminalTipsMinor = already + addMinor;
    await prisma.$transaction([
      (prisma as any).order.update({
        where: { id: order.id },
        data: { tipAmount: Number(order.tipAmount ?? 0) + addMinor / 100, metadata: meta as any },
      }),
      ...rows.map((p: any) =>
        (prisma as any).payment.update({
          where: { id: p.id },
          data: { metadata: { ...((p.metadata as any) ?? {}), tipAppliedToOrder: true } },
        }),
      ),
    ]);
    changed += 1;
  }

  console.log(
    APPLY
      ? `\nDone — ${changed} order(s) now show the tip left on the card machine.`
      : `\nDry run only. Re-run with APPLY=true to write these changes.`,
  );

  await fixCashLabels();
}

/**
 * A dine-in tab opens at the till as CASH and is often settled later on a card
 * machine. Nothing moved it off CASH, so the board showed a green "Cash" chip
 * on a table paid by card — and a refund against it showed no badge at all,
 * because the cash chip has no refunded state.
 */
async function fixCashLabels() {
  const orders = await (prisma as any).order.findMany({
    where: {
      paymentMethod: "CASH",
      ...(ONLY_ORDER ? { id: ONLY_ORDER } : {}),
      payments: {
        some: { method: "CARD", status: { in: ["SUCCEEDED", "REFUNDED"] } },
      },
    },
    select: {
      id: true,
      displayId: true,
      total: true,
      payments: {
        where: { method: "CARD", status: { in: ["SUCCEEDED", "REFUNDED"] } },
        select: { provider: true, amount: true },
      },
    },
  });
  if (!orders.length) {
    console.log("\nNo order is calling a card payment cash.");
    return;
  }

  console.log(`\n${orders.length} order(s) paid by card but still labelled CASH${APPLY ? "" : " — DRY RUN"}`);
  for (const o of orders) {
    const paid = o.payments.reduce((s: number, p: any) => s + minor(p.amount), 0);
    console.log(
      `  ${o.displayId ?? o.id.slice(-8)} (${o.id}) — ${money(paid)} on ${o.payments
        .map((p: any) => p.provider)
        .join(", ")} against a ${money(minor(o.total))} bill → CARD_TERMINAL`,
    );
    if (APPLY) {
      await (prisma as any).order.update({ where: { id: o.id }, data: { paymentMethod: "CARD_TERMINAL" } });
    }
  }
  if (!APPLY) console.log("Dry run only. Re-run with APPLY=true to write these changes.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
