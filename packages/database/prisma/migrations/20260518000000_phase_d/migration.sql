-- Phase D: Restaurant product additions
-- Menu status, Location online ordering fields

-- MenuStatus enum
CREATE TYPE "MenuStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- Menu: add status and description
ALTER TABLE "menus" ADD COLUMN "description" TEXT;
ALTER TABLE "menus" ADD COLUMN "status" "MenuStatus" NOT NULL DEFAULT 'DRAFT';
CREATE INDEX "menus_brandId_status_idx" ON "menus"("brandId", "status");

-- Location: online ordering fields
ALTER TABLE "locations" ADD COLUMN "slug" TEXT;
ALTER TABLE "locations" ADD COLUMN "openingHours" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "locations" ADD COLUMN "deliveryConfig" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "locations" ADD COLUMN "onboardingStep" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "locations_slug_key" ON "locations"("slug") WHERE "slug" IS NOT NULL;
