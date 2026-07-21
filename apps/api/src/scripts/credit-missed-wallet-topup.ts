/**
 * Manually credit a wallet top-up whose Stripe webhook was never delivered
 * (e.g. paid before the platform-account webhook existed). Mirrors
 * WalletService.creditFromStripePi exactly and is idempotent on the
 * PaymentIntent id, so it can never double-credit — even if the real webhook
 * is later resent.
 *
 * Required env:
 *   PI_ID         the succeeded top-up PaymentIntent id (pi_…)
 *   AMOUNT_MINOR  amount in pennies (e.g. 500 for £5.00)
 * Optional:
 *   WALLET_ID     credit this exact wallet; if omitted, uses the wallet of the
 *                 most recent successful top-up (the location you just funded)
 *   APPLY=true    write (default = dry run)
 *
 *   APPLY=true PI_ID=pi_xxx AMOUNT_MINOR=500 DATABASE_URL=<url> \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/credit-missed-wallet-topup.ts
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === "true";
const PI_ID = process.env.PI_ID;
const AMOUNT_MINOR = parseInt(process.env.AMOUNT_MINOR ?? "", 10);
const WALLET_ID = process.env.WALLET_ID;

async function main() {
  console.log(`\n=== credit-missed-wallet-topup — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);
  if (!PI_ID || !Number.isFinite(AMOUNT_MINOR) || AMOUNT_MINOR <= 0) {
    throw new Error("PI_ID and a positive AMOUNT_MINOR are required.");
  }

  const db = prisma as any;

  // Idempotency — identical to the webhook path.
  const already = await db.walletTransaction.findFirst({
    where: { stripePaymentIntentId: PI_ID, type: "TOPUP" },
    select: { id: true },
  });
  if (already) {
    console.log(`PI ${PI_ID} is ALREADY credited (txn ${already.id}) — nothing to do.\n`);
    return;
  }

  // Resolve the target wallet.
  let wallet: any;
  if (WALLET_ID) {
    wallet = await db.wallet.findUnique({ where: { id: WALLET_ID } });
  } else {
    const lastTopup = await db.walletTransaction.findFirst({
      where: { type: "TOPUP" },
      orderBy: { createdAt: "desc" },
      select: { walletId: true },
    });
    if (lastTopup?.walletId) {
      wallet = await db.wallet.findUnique({ where: { id: lastTopup.walletId } });
    }
  }
  if (!wallet) {
    throw new Error(
      "Could not resolve a target wallet. Pass WALLET_ID=… explicitly.",
    );
  }

  const loc = await db.location
    .findUnique({ where: { id: wallet.locationId ?? "" }, select: { name: true } })
    .catch(() => null);

  console.log(`Target wallet:   ${wallet.id}`);
  console.log(`Location:        ${loc?.name ?? wallet.locationId ?? "(tenant-wide)"}`);
  console.log(`Current balance: £${(wallet.balanceMinor / 100).toFixed(2)}`);
  console.log(`Credit:          +£${(AMOUNT_MINOR / 100).toFixed(2)}  (PI ${PI_ID})`);
  console.log(`New balance:     £${((wallet.balanceMinor + AMOUNT_MINOR) / 100).toFixed(2)}\n`);

  if (!APPLY) {
    console.log("Dry run — set APPLY=true to write.\n");
    return;
  }

  await prisma.$transaction(async (tx: any) => {
    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceMinor: { increment: AMOUNT_MINOR } },
    });
    await tx.walletTransaction.create({
      data: {
        tenantId: wallet.tenantId,
        walletId: wallet.id,
        locationId: wallet.locationId ?? null,
        type: "TOPUP",
        amountMinor: AMOUNT_MINOR,
        balanceAfterMinor: updated.balanceMinor,
        currency: wallet.currency ?? "GBP",
        purpose: "TOPUP",
        stripePaymentIntentId: PI_ID,
        description: `Top-up £${(AMOUNT_MINOR / 100).toFixed(2)} (manual recovery — webhook missed)`,
      },
    });
    console.log(
      `Credited. New balance £${(updated.balanceMinor / 100).toFixed(2)}.\n`,
    );
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
