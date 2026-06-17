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
--
-- Every statement is independently idempotent (IF NOT EXISTS / DROP
-- IF EXISTS / `WHERE NOT EXISTS` guards) so a half-applied + retry
-- run picks up exactly where the previous attempt stopped. Don't
-- wrap the file in BEGIN/COMMIT — Prisma already runs each migration
-- in its own implicit tx.

-- 1. Brand columns — added one statement at a time so a per-column
--    failure leaves the others in a known state (multi-column ALTERs
--    can be hard to reason about on partial failure).
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "phone"                     TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "addressLine1"              TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "addressLine2"              TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "city"                      TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "postcode"                  TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "country"                   TEXT NOT NULL DEFAULT 'GB';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "customDomain"              TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "customDomainStatus"        TEXT NOT NULL DEFAULT 'not_configured';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "stripeConnectedAccountId"  TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "applicationFeeFixedAmount" DECIMAL(10,2);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "applicationFeePercentage"  DECIMAL(5,2);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "applicationFeeMode"        TEXT NOT NULL DEFAULT 'none';

-- 2. DirectOrderingConfig: switch the primary key from location → brand.
ALTER TABLE "direct_ordering_configs"
  ADD COLUMN IF NOT EXISTS "brandId" TEXT;

-- 3. Backfill brandId from each row's location.brandId. If two configs
--    point at locations under the same brand (multi-location franchise
--    that filled in direct ordering twice), keeping both would break
--    the unique index in step 4. Resolve by clearing the brandId on
--    the older duplicates — operators can re-attach manually under
--    the new brand-keyed UI.
UPDATE "direct_ordering_configs" doc
SET    "brandId" = loc."brandId"
FROM   "locations" loc
WHERE  doc."locationId" = loc."id"
  AND  doc."brandId" IS NULL;

WITH ranked AS (
  SELECT id, "brandId",
         ROW_NUMBER() OVER (
           PARTITION BY "brandId"
           ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
         ) AS rn
  FROM   "direct_ordering_configs"
  WHERE  "brandId" IS NOT NULL
)
UPDATE "direct_ordering_configs" doc
SET    "brandId" = NULL
FROM   ranked
WHERE  doc.id = ranked.id
  AND  ranked.rn > 1;

-- 4. Drop the NOT NULL on locationId so post-cutover the API can
--    write brand-only rows.
ALTER TABLE "direct_ordering_configs"
  ALTER COLUMN "locationId" DROP NOT NULL;

-- 5. Unique + plain indexes. Partial-uniqueness via Postgres' default
--    NULLs-are-distinct treatment.
CREATE UNIQUE INDEX IF NOT EXISTS "direct_ordering_configs_brandId_key"
  ON "direct_ordering_configs" ("brandId");

CREATE INDEX IF NOT EXISTS "direct_ordering_configs_brandId_idx"
  ON "direct_ordering_configs" ("brandId");

-- 6. FK so a deleted brand cascades the config row away (mirrors what
--    locationId already does).
ALTER TABLE "direct_ordering_configs"
  DROP CONSTRAINT IF EXISTS "direct_ordering_configs_brandId_fkey";

ALTER TABLE "direct_ordering_configs"
  ADD CONSTRAINT "direct_ordering_configs_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE;
