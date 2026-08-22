-- Trading currency per location, so a Dubai shop stops reading its AED prices
-- as pounds. Its OWN migration, not an edit to an earlier one: Prisma
-- checksums every applied migration and refuses one whose contents changed,
-- which aborts start-api.sh before the API boots.
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'GBP';

-- Backfill from the country already on the row. Every existing location is GB
-- and stays GBP; this only matters for rows created before the column existed
-- in a non-GB country.
UPDATE "locations" SET "currency" = 'AED' WHERE "country" = 'AE';
UPDATE "locations" SET "currency" = 'SAR' WHERE "country" = 'SA';
UPDATE "locations" SET "currency" = 'KWD' WHERE "country" = 'KW';
UPDATE "locations" SET "currency" = 'QAR' WHERE "country" = 'QA';
UPDATE "locations" SET "currency" = 'BHD' WHERE "country" = 'BH';
UPDATE "locations" SET "currency" = 'OMR' WHERE "country" = 'OM';
UPDATE "locations" SET "currency" = 'JOD' WHERE "country" = 'JO';
UPDATE "locations" SET "currency" = 'EGP' WHERE "country" = 'EG';
UPDATE "locations" SET "currency" = 'EUR' WHERE "country" = 'IE';
UPDATE "locations" SET "currency" = 'USD' WHERE "country" = 'US';
