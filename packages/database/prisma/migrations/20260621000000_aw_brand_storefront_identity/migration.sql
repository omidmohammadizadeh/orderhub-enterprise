-- Phase AW — brand-level storefront identity.
--
-- Each brand becomes a customer-facing identity in its own right:
-- its own address, phone, custom domain, Stripe Connect account, and
-- application-fee config. A single physical location running three
-- virtual brands can now publish three independent storefronts —
-- each with its own URL, receipt header, and payout account.
--
-- The Location keeps every column it had (ops still need to know
-- where the kitchen physically is); we just add a parallel set on
-- the Brand for the public-facing identity. Storefront + receipt
-- code in later AW phases will read from the brand first, fall
-- back to the location for backwards compatibility.

ALTER TABLE "brands"
  ADD COLUMN IF NOT EXISTS "phone"                     TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine1"              TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine2"              TEXT,
  ADD COLUMN IF NOT EXISTS "city"                      TEXT,
  ADD COLUMN IF NOT EXISTS "postcode"                  TEXT,
  ADD COLUMN IF NOT EXISTS "country"                   TEXT NOT NULL DEFAULT 'GB',
  ADD COLUMN IF NOT EXISTS "customDomain"              TEXT,
  ADD COLUMN IF NOT EXISTS "customDomainStatus"        TEXT NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS "stripeConnectedAccountId"  TEXT,
  ADD COLUMN IF NOT EXISTS "applicationFeeFixedAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "applicationFeePercentage"  DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "applicationFeeMode"        TEXT NOT NULL DEFAULT 'none';

-- DirectOrderingConfig: switch the primary key from location → brand.
-- 1. Add brandId column (nullable while we backfill + cut over).
-- 2. Backfill brandId from each row's location.brandId so existing
--    storefront configs keep working under the new key.
-- 3. Drop the NOT NULL on locationId so post-cutover writes can
--    create brand-only rows.
-- 4. Add a uniq + plain index on brandId.

ALTER TABLE "direct_ordering_configs"
  ADD COLUMN IF NOT EXISTS "brandId" TEXT;

UPDATE "direct_ordering_configs" doc
SET    "brandId" = loc."brandId"
FROM   "locations" loc
WHERE  doc."locationId" = loc."id"
  AND  doc."brandId" IS NULL;

ALTER TABLE "direct_ordering_configs"
  ALTER COLUMN "locationId" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "direct_ordering_configs_brandId_key"
  ON "direct_ordering_configs" ("brandId");

CREATE INDEX IF NOT EXISTS "direct_ordering_configs_brandId_idx"
  ON "direct_ordering_configs" ("brandId");

-- FK so a deleted brand cascades the config row away (mirrors what
-- locationId already does).
ALTER TABLE "direct_ordering_configs"
  DROP CONSTRAINT IF EXISTS "direct_ordering_configs_brandId_fkey";

ALTER TABLE "direct_ordering_configs"
  ADD CONSTRAINT "direct_ordering_configs_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE;
