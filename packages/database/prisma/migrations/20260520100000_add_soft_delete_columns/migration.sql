-- Add soft-delete (deletedAt) columns to configuration entities.
--
-- These columns are defined in schema.prisma but were never included in any
-- migration SQL file, causing Prisma to throw "column does not exist" at
-- runtime for any query that selects or filters on deletedAt.
--
-- All statements use IF NOT EXISTS so this migration is idempotent and safe
-- to re-run if the deployment was interrupted.

ALTER TABLE "brands"       ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "locations"    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "menus"        ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "printers"     ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Indexes referenced by @@index directives in schema.prisma
CREATE INDEX IF NOT EXISTS "brands_tenantId_deletedAt_idx"    ON "brands"("tenantId", "deletedAt");
CREATE INDEX IF NOT EXISTS "locations_brandId_deletedAt_idx"  ON "locations"("brandId", "deletedAt");
