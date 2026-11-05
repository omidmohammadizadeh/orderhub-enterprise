-- Eat For Less keeps customers' card payments in its own balance and pays
-- each shop once a week, on Thursday, net of commission (card and cash) and
-- refunds.
CREATE TYPE "EflPayoutStatus" AS ENUM ('PENDING', 'TRANSFERRED', 'PAID', 'NOTHING_DUE', 'FAILED');

CREATE TABLE "efl_payouts" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "status" "EflPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "cardPence" INTEGER NOT NULL,
    "cashCommissionPence" INTEGER NOT NULL,
    "refundsPence" INTEGER NOT NULL,
    "carriedInPence" INTEGER NOT NULL,
    "amountPence" INTEGER NOT NULL,
    "carriedOutPence" INTEGER NOT NULL,
    "stripeTransferId" TEXT,
    "stripePayoutId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_payouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_payouts_listingId_weekStart_key" ON "efl_payouts"("listingId", "weekStart");
CREATE INDEX "efl_payouts_status_idx" ON "efl_payouts"("status");
ALTER TABLE "efl_payouts" ADD CONSTRAINT "efl_payouts_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "efl_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "efl_payout_lines" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "toShopPence" INTEGER NOT NULL,
    "clawedBackPence" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "efl_payout_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_payout_lines_orderId_key" ON "efl_payout_lines"("orderId");
CREATE INDEX "efl_payout_lines_payoutId_idx" ON "efl_payout_lines"("payoutId");
ALTER TABLE "efl_payout_lines" ADD CONSTRAINT "efl_payout_lines_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "efl_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
