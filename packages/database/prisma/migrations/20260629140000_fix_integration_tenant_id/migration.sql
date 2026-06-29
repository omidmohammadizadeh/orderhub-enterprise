-- Heal a schema/DB drift: the Prisma `Integration` model declares `tenantId`
-- and `syncMetadata`, but the original `integrations` table was created without
-- them and no migration ever added them. As a result ANY integration write
-- (HubRise, WhatsApp, …) failed with: column `tenantId` does not exist.
--
-- Idempotent + safe: adds the columns if missing, backfills tenantId from each
-- integration's location → brand → tenant, and creates the declared indexes.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "syncMetadata" JSONB NOT NULL DEFAULT '{}';

-- Backfill any pre-existing rows so they aren't orphaned.
UPDATE "integrations" i
SET "tenantId" = b."tenantId"
FROM "locations" l
JOIN "brands" b ON b."id" = l."brandId"
WHERE i."locationId" = l."id" AND i."tenantId" IS NULL;

-- Match the schema's @@index([tenantId]) and @@index([tenantId, platform]).
CREATE INDEX IF NOT EXISTS "integrations_tenantId_idx" ON "integrations"("tenantId");
CREATE INDEX IF NOT EXISTS "integrations_tenantId_platform_idx" ON "integrations"("tenantId", "platform");
