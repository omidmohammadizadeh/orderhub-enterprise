-- Phase BF correction — the previous migration
-- (20260710210000_bf_variant_channel_assignment) put variant-menu config on
-- MenuChannelAssignment, which meant re-picking a menu+variant on every
-- publish action. That's wrong: it should be a STANDING per-(brand,
-- channel) setting, auto-resolving the variant the same way HubRise
-- already does (a variant is already tagged with its own brandId +
-- channelKey). Drop those columns and replace with brand_channel_sources.
ALTER TABLE "menu_channel_assignments"
  DROP CONSTRAINT IF EXISTS "menu_channel_assignments_variantSourceMenuId_fkey";

DROP INDEX IF EXISTS "menu_channel_assignments_variantSourceMenuId_idx";

ALTER TABLE "menu_channel_assignments"
  DROP COLUMN IF EXISTS "variantSourceMenuId",
  DROP COLUMN IF EXISTS "variantRef";

CREATE TABLE "brand_channel_sources" (
  "id"           TEXT NOT NULL,
  "brandId"      TEXT NOT NULL,
  "channel"      TEXT NOT NULL,
  "sourceMenuId" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_channel_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brand_channel_sources_brandId_channel_key"
  ON "brand_channel_sources"("brandId", "channel");

CREATE INDEX "brand_channel_sources_sourceMenuId_idx"
  ON "brand_channel_sources"("sourceMenuId");

ALTER TABLE "brand_channel_sources"
  ADD CONSTRAINT "brand_channel_sources_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brand_channel_sources"
  ADD CONSTRAINT "brand_channel_sources_sourceMenuId_fkey"
  FOREIGN KEY ("sourceMenuId") REFERENCES "menus"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
