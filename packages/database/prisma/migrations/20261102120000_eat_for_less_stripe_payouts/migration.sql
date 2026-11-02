-- Eat For Less charges customers on its own Stripe account and pays each
-- shop through an Express account on that platform.
ALTER TABLE "efl_listings" ADD COLUMN "stripeAccountId" TEXT;
ALTER TABLE "efl_listings" ADD COLUMN "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "efl_listings_stripeAccountId_key" ON "efl_listings"("stripeAccountId");
