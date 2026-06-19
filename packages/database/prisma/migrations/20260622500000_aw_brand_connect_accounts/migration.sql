-- Phase AW-30 — per-brand Stripe Connect accounts for embedded onboarding.
-- The existing table already supports tenant-level (both null) and
-- per-location (locationId set) accounts; this adds the per-brand
-- variant the Payments page now manages.

ALTER TABLE "stripe_connect_accounts"
  ADD COLUMN "brandId" TEXT;

CREATE UNIQUE INDEX "stripe_connect_accounts_brandId_key"
  ON "stripe_connect_accounts"("brandId");

CREATE INDEX "stripe_connect_accounts_brandId_idx"
  ON "stripe_connect_accounts"("brandId");
