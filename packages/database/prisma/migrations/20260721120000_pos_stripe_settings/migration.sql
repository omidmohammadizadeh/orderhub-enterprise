-- POS Stripe settings — per-location Connect account + application fee used by
-- POS "Payment link" charges (overrides the brand/location cascade so a shop's
-- card links land on its own Stripe account with its own platform fee).

ALTER TABLE "locations"
    ADD COLUMN "posStripeAccountId" TEXT,
    ADD COLUMN "posApplicationFeePercent" DECIMAL(5,2),
    ADD COLUMN "posApplicationFeeFixedMinor" INTEGER;
