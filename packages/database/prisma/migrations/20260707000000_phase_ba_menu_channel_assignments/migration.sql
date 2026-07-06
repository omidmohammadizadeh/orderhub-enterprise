-- Phase BA — multi-location menu serving assignments + per-location snoozes.
--
-- 1. menu_channel_assignments: one row = "menu M serves (location, channel,
--    brand)". Unique on (locationId, channel, brandId) so an upsert on that
--    key IS the replace semantics; a menu holds many rows (many locations /
--    channels) simultaneously. Menu.locationId demotes to "home location".
-- 2. menu_item_channel_availability.locationId: NULL = all locations (every
--    pre-BA row); non-null scopes a snooze to one location. Postgres treats
--    NULLs as distinct inside the new compound unique, so a partial unique
--    index below keeps the legacy global slice one-row-per-(item, channel).
-- 3. Backfill: every published/active location-homed menu gets one
--    assignment per publishedTo channel; on (location, channel, brand)
--    conflicts the most recently published menu wins — matching the
--    orderBy(lastPublishedAt desc, updatedAt desc) the readers used.

-- DropIndex
DROP INDEX "menu_item_channel_availability_itemId_channel_key";

-- AlterTable
ALTER TABLE "menu_item_channel_availability" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "menu_channel_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "menuId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_channel_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_channel_assignments_menuId_idx" ON "menu_channel_assignments"("menuId");

-- CreateIndex
CREATE INDEX "menu_channel_assignments_locationId_channel_idx" ON "menu_channel_assignments"("locationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "menu_channel_assignments_locationId_channel_brandId_key" ON "menu_channel_assignments"("locationId", "channel", "brandId");

-- CreateIndex
CREATE INDEX "menu_item_channel_availability_locationId_idx" ON "menu_item_channel_availability"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_channel_availability_itemId_channel_locationId_key" ON "menu_item_channel_availability"("itemId", "channel", "locationId");

-- Partial unique index: keeps the legacy/global slice (locationId IS NULL)
-- one-row-per-(item, channel) — the compound unique above can't, because
-- Postgres treats NULLs as distinct. App code upserts location rows via the
-- compound key and uses findFirst→update|create for global rows; this index
-- backstops races on the latter.
CREATE UNIQUE INDEX "menu_item_channel_availability_itemId_channel_global_key"
  ON "menu_item_channel_availability" ("itemId", "channel")
  WHERE "locationId" IS NULL;

-- AddForeignKey
ALTER TABLE "menu_channel_assignments" ADD CONSTRAINT "menu_channel_assignments_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_channel_assignments" ADD CONSTRAINT "menu_channel_assignments_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_channel_availability" ADD CONSTRAINT "menu_item_channel_availability_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill serving assignments from the pre-BA single-location model.
-- tenantId comes via the brand (menus have no tenant column).
INSERT INTO "menu_channel_assignments"
  ("id", "tenantId", "menuId", "locationId", "brandId", "channel", "publishedAt", "createdAt", "updatedAt")
SELECT DISTINCT ON (m."locationId", ch.channel, m."brandId")
  md5(random()::text || clock_timestamp()::text || m."id" || ch.channel),
  b."tenantId",
  m."id",
  m."locationId",
  m."brandId",
  ch.channel,
  COALESCE(m."lastPublishedAt", m."updatedAt"),
  NOW(),
  NOW()
FROM "menus" m
JOIN "brands" b ON b."id" = m."brandId"
CROSS JOIN LATERAL unnest(m."publishedTo") AS ch(channel)
WHERE m."locationId" IS NOT NULL
  AND m."deletedAt" IS NULL
  AND (m."status" = 'PUBLISHED' OR m."isActive" = true)
ORDER BY m."locationId", ch.channel, m."brandId",
         m."lastPublishedAt" DESC NULLS LAST, m."updatedAt" DESC;
