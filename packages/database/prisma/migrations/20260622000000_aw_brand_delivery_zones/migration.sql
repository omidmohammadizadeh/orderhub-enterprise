-- Phase AW-30 — allow DeliveryZone to be keyed by brand OR location.
-- Existing rows stay location-keyed; new brand-keyed rows added by the
-- brand settings drawer. Storefront resolution prefers brand zones
-- when a brand is pinned.

ALTER TABLE "delivery_zones"
  ALTER COLUMN "locationId" DROP NOT NULL,
  ADD COLUMN "brandId" TEXT;

ALTER TABLE "delivery_zones"
  ADD CONSTRAINT "delivery_zones_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "delivery_zones_brandId_postcodePrefix_key"
  ON "delivery_zones"("brandId", "postcodePrefix");

CREATE INDEX "delivery_zones_brandId_idx" ON "delivery_zones"("brandId");
