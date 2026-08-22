-- Area-based delivery zones, alongside the existing postcode prefixes and
-- distance bands.
--
-- The Gulf has no postal code system in everyday use — a Dubai address is
-- building, community, emirate — so postcode zones cannot price a Dubai shop at
-- all. An area row names the community it prices ("Dubai Marina", "JLT",
-- "Business Bay") and the customer picks from the operator's own list.
--
-- Additive only. Existing rows are postcode or radius rows and are untouched;
-- areaName stays NULL on them, and a zone set's mode is still derived from its
-- rows rather than from a flag that could drift out of step with them.
ALTER TABLE "delivery_zones" ADD COLUMN "areaName" TEXT;

-- Same shape as the postcode uniques: one row per area per location/brand.
-- Postgres treats NULLs as distinct, so these do not constrain the postcode and
-- radius rows that leave areaName empty.
CREATE UNIQUE INDEX "delivery_zones_locationId_areaName_key"
  ON "delivery_zones"("locationId", "areaName");
CREATE UNIQUE INDEX "delivery_zones_brandId_areaName_key"
  ON "delivery_zones"("brandId", "areaName");
