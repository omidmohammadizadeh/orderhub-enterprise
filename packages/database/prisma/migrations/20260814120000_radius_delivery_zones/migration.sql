-- Radius-based delivery fees alongside the existing postcode bands.
--
-- A zone row is now EITHER a postcode prefix or a distance band. Existing rows
-- are all postcode rows and are untouched; postcodePrefix simply becomes
-- nullable so radius rows can leave it empty.
ALTER TABLE "delivery_zones" ALTER COLUMN "postcodePrefix" DROP NOT NULL;
ALTER TABLE "delivery_zones" ADD COLUMN "maxDistanceMiles" DECIMAL(6,2);

-- Where radius fees measure from. Geocoded from the location's own postcode.
ALTER TABLE "locations" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "locations" ADD COLUMN "longitude" DOUBLE PRECISION;
