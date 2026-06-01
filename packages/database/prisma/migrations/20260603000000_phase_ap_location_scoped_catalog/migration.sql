-- Phase AP — Products section becomes location-scoped (operator request).
--
-- Adds nullable locationId to menu_items + modifier_groups so each row
-- can be pinned to a specific shop. The web Products tab queries by
-- location, mirroring the Menu tab change in the previous commit.
--
-- Backfill rule (idempotent):
--   For every tenant, find a location whose name contains "PIZZA UNO PELTON"
--   (case-insensitive). If one exists, stamp every existing menu_item /
--   modifier_group that belongs to that tenant's brands with that
--   location's id. Tenants with no such location keep locationId NULL —
--   their rows stay brand-scoped for now and the operator can re-assign
--   later from the Products tab's location selector.

ALTER TABLE "menu_items"
  ADD COLUMN IF NOT EXISTS "locationId" TEXT;

ALTER TABLE "modifier_groups"
  ADD COLUMN IF NOT EXISTS "locationId" TEXT;

CREATE INDEX IF NOT EXISTS "menu_items_locationId_idx"
  ON "menu_items"("locationId");
CREATE INDEX IF NOT EXISTS "modifier_groups_locationId_idx"
  ON "modifier_groups"("locationId");

-- Pin existing rows to "Pizza Uno Pelton" where it exists, on a
-- per-tenant basis. Skip rows that already have locationId so re-runs
-- don't disturb manual assignments.
WITH pelton_per_tenant AS (
  SELECT DISTINCT ON (b."tenantId")
    b."tenantId" AS tenant_id,
    l."id"       AS location_id
  FROM "locations" l
  JOIN "brands"    b ON b."id" = l."brandId"
  WHERE l."deletedAt" IS NULL
    AND UPPER(l."name") LIKE '%PIZZA UNO PELTON%'
  ORDER BY b."tenantId", l."createdAt" ASC
)
UPDATE "menu_items" mi
SET    "locationId" = ppt.location_id
FROM   "brands" b, pelton_per_tenant ppt
WHERE  mi."brandId" = b."id"
  AND  b."tenantId" = ppt.tenant_id
  AND  mi."locationId" IS NULL;

WITH pelton_per_tenant AS (
  SELECT DISTINCT ON (b."tenantId")
    b."tenantId" AS tenant_id,
    l."id"       AS location_id
  FROM "locations" l
  JOIN "brands"    b ON b."id" = l."brandId"
  WHERE l."deletedAt" IS NULL
    AND UPPER(l."name") LIKE '%PIZZA UNO PELTON%'
  ORDER BY b."tenantId", l."createdAt" ASC
)
UPDATE "modifier_groups" mg
SET    "locationId" = ppt.location_id
FROM   "brands" b, pelton_per_tenant ppt
WHERE  mg."brandId" = b."id"
  AND  b."tenantId" = ppt.tenant_id
  AND  mg."locationId" IS NULL;
