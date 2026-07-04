-- kds_screens was created by the init migration WITHOUT tenantId; the field
-- was later added to the Prisma model with no migration, so screen creation
-- fails in production ("column tenantId does not exist"). Add it, backfill
-- from the owning location's brand, enforce, and index (all idempotent).

ALTER TABLE "kds_screens" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "kds_screens" ks
SET "tenantId" = b."tenantId"
FROM "locations" l
JOIN "brands" b ON l."brandId" = b."id"
WHERE ks."locationId" = l."id" AND ks."tenantId" IS NULL;

-- Orphan screens (location gone) can't be tenant-resolved — drop them.
DELETE FROM "kds_screens" WHERE "tenantId" IS NULL;

ALTER TABLE "kds_screens" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "kds_screens_tenantId_idx" ON "kds_screens"("tenantId");
CREATE INDEX IF NOT EXISTS "kds_screens_locationId_isActive_idx" ON "kds_screens"("locationId", "isActive");
