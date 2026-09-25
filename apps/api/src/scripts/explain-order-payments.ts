/**
 * Explain every payment on an order — what was taken, by what, when, and how
 * much of it is still ours.
 *
 * There is no screen for this. The Payments page is a summary, and the order
 * drawer only lists DOJO rows, so a payment from any other route is invisible
 * in the dashboard. That gap is how a £4.13 part payment sat on a £26.72 table
 * tab without anyone knowing (2026-09-25) — the till then offered to charge
 * the whole bill again.
 *
 * Read-only. It writes nothing.
 *
 * Usage:
 *   ORDER_ID=cmugw6evy005ea3t0k7g5hys2 node apps/api/dist/scripts/explain-order-payments.js
 *
 * ORDER_ID also accepts the short display id (e.g. 9X6NP).
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();
const ORDER = process.env["ORDER_ID"]?.trim();

const money = (n: unknown) => `£${Number(n ?? 0).toFixed(2)}`;
const minor = (n: unknown) => Math.round(Number(n ?? 0) * 100);

async function main() {
  if (!ORDER) throw new Error("Set ORDER_ID (the order id, or its short display id)");

  const order = await (prisma as any).order.findFirst({
    where: { OR: [{ id: ORDER }, { displayId: ORDER }] },
    select: {
      id: true,
      displayId: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      total: true,
      tableId: true,
      createdAt: true,
    },
  });
  if (!order) throw new Error(`No order matching "${ORDER}"`);

  const payments = await (prisma as any).payment.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      provider: true,
      method: true,
      amount: true,
      tipAmount: true,
      currency: true,
      providerChargeId: true,
      stripePaymentIntentId: true,
      metadata: true,
      createdAt: true,
    },
  });

  console.log(
    `\nOrder ${order.displayId ?? order.id} (${order.id})\n` +
      `  status ${order.status} · payment ${order.paymentStatus} · method ${order.paymentMethod}\n` +
      `  total ${money(order.total)}${order.tableId ? " · dine-in tab" : ""}\n` +
      `  created ${order.createdAt.toISOString()}\n`,
  );

  if (payments.length === 0) {
    console.log("  No payment rows at all.\n");
    return;
  }

  let keptMinor = 0;
  for (const p of payments) {
    const refunded = Number((p.metadata as any)?.refundedMinor ?? 0);
    // Only a SUCCEEDED row is money we hold, and only the part not refunded.
    const kept = p.status === "SUCCEEDED" ? Math.max(0, minor(p.amount) - refunded) : 0;
    keptMinor += kept;
    const meta = p.metadata as any;
    const tags = [
      meta?.split ? "split" : null,
      meta?.source ? `source:${meta.source}` : null,
      refunded ? `refunded ${money(refunded / 100)}` : null,
      Number(p.tipAmount) > 0 ? `tip ${money(p.tipAmount)}` : null,
    ].filter(Boolean);
    console.log(
      `  ${money(p.amount)}  ${p.status.padEnd(10)} ${String(p.provider ?? "-").padEnd(8)} ` +
        `${String(p.method ?? "-").padEnd(14)} counts ${money(kept / 100)}\n` +
        `      ${p.id}  ${p.createdAt.toISOString()}\n` +
        `      charge ${p.providerChargeId ?? p.stripePaymentIntentId ?? "—"}` +
        (tags.length ? `  [${tags.join(", ")}]` : ""),
    );
  }

  const outstanding = Math.max(0, minor(order.total) - keptMinor);
  console.log(
    `\n  Paid ${money(keptMinor / 100)} of ${money(order.total)} → ` +
      `${money(outstanding / 100)} outstanding\n`,
  );
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
