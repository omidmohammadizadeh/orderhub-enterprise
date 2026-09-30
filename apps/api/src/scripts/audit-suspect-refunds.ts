/**
 * List refunds that were BOOKED but may never have reached the customer.
 *
 * Until 8b6e2bbc, POST /v1/payments/:paymentId/refund wrote a SUCCEEDED
 * Refund + ledger entry whether or not money moved:
 *   - it called Stripe without {stripeAccount}, so a direct charge (every
 *     terminal and storefront payment) failed — and the error was swallowed,
 *     leaving stripeRefundId NULL;
 *   - with no PaymentIntent (Dojo, Tap, or Stripe not configured) it invented
 *     a `mock_re_<timestamp>` id instead.
 * Every other path (Dojo's recordRefund, retail returns, the cancel refund)
 * only writes after the provider confirms, so these two signatures are the
 * whole of the problem. NB repair-refunded-orders.ts trusts Refund rows as
 * the truth — run this first and resolve anything it finds.
 *
 * READ-ONLY. Writes nothing; prints each suspect refund so it can be checked
 * against the Stripe / Dojo dashboard and either refunded for real or
 * reversed in the books by hand.
 *
 *   DATABASE_URL=<url> npx ts-node -P apps/api/tsconfig.json \
 *     apps/api/src/scripts/audit-suspect-refunds.ts
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();

const money = (n: unknown, ccy = "gbp") =>
  `${ccy.toUpperCase()} ${Number(n ?? 0).toFixed(2)}`;

async function main() {
  const suspects = await prisma.refund.findMany({
    where: {
      status: "SUCCEEDED",
      OR: [
        // Invented id: no provider was ever asked.
        { stripeRefundId: { startsWith: "mock_re_" } },
        // A Stripe payment "refunded" with no Stripe refund id: the call
        // failed and was swallowed. Dojo/cash/retail rows never land here —
        // their payments have no PaymentIntent, or they carry a refund id.
        { stripeRefundId: null, payment: { stripePaymentIntentId: { not: null } } },
      ],
    },
    include: {
      payment: {
        select: {
          id: true,
          provider: true,
          method: true,
          currency: true,
          stripePaymentIntentId: true,
          providerChargeId: true,
          order: { select: { id: true, orderNumber: true, displayId: true, tenantId: true, locationId: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (suspects.length === 0) {
    console.log("No suspect refunds — every booked refund has a real provider reference (or was cash).");
    return;
  }

  const byCcy = new Map<string, number>();
  console.log(`${suspects.length} refund(s) booked without proof the money moved:\n`);
  for (const r of suspects) {
    const p = r.payment;
    const ccy = p?.currency ?? "gbp";
    byCcy.set(ccy, (byCcy.get(ccy) ?? 0) + Number(r.amount));
    const why = r.stripeRefundId?.startsWith("mock_re_")
      ? "invented id — no provider called"
      : "Stripe call failed silently";
    console.log(
      [
        `refund ${r.id}`,
        `  when      ${r.createdAt.toISOString()}`,
        `  amount    ${money(r.amount, ccy)}${r.isPartial ? " (partial)" : ""}`,
        `  order     #${p?.order?.orderNumber ?? p?.order?.displayId ?? "?"} (${p?.order?.id ?? "?"}) tenant ${p?.order?.tenantId ?? "?"}`,
        `  payment   ${p?.id} ${p?.provider ?? "?"} ${p?.method ?? "?"} ${p?.stripePaymentIntentId ?? p?.providerChargeId ?? ""}`,
        `  why       ${why}`,
        `  reason    ${r.reason ?? "—"}`,
        "",
      ].join("\n"),
    );
  }
  console.log(
    `Total booked but unproven: ${[...byCcy].map(([c, n]) => money(n, c)).join(", ")}\n` +
      "Check each against the provider dashboard: if the customer was never refunded, refund them\n" +
      "there, or correct the Refund/ledger rows. This script changes nothing.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
