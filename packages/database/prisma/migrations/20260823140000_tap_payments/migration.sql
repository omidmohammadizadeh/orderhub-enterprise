-- Tap Payments alongside Stripe.
--
-- Stripe stays the UK/IE money path and is untouched; Tap takes the Gulf,
-- because Stripe's own UAE Connect rules forbid the direct-charge model our
-- storefront checkout is built on.
--
-- Additive only. Existing payment rows are all Stripe and are backfilled to
-- say so by the column default.
ALTER TABLE "payments" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'STRIPE';
ALTER TABLE "payments" ADD COLUMN "providerChargeId" TEXT;

-- A charge id must be unique so a replayed webhook cannot settle the same
-- money twice. Tap retries its webhook, so this is load-bearing, not hygiene.
CREATE UNIQUE INDEX "payments_providerChargeId_key" ON "payments"("providerChargeId");

-- Where a brand's share of a split charge settles. The Gulf counterpart of
-- brands."stripeConnectedAccountId".
ALTER TABLE "brands" ADD COLUMN "tapDestinationId" TEXT;
ALTER TABLE "brands" ADD COLUMN "tapBusinessId" TEXT;
