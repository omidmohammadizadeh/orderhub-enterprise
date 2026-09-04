-- One driver record per login.
--
-- A driver signing in for the first time had several requests land at once —
-- the app fetches its profile, its day, its chat count and registers a push
-- token in parallel — and each one ran the same find-then-create. None of them
-- found a driver, so each created one. Four rows for one person, all with the
-- same email, and dispatch could pick any of them; the one it picked was often
-- not the one the phone was polling as.
--
-- Fold the duplicates into the earliest row, then let the database refuse to
-- make the mistake again.

-- 1. The keeper for each login: the earliest row, deterministic on ties.
CREATE TEMP TABLE driver_keepers AS
SELECT DISTINCT ON ("tenantId", "userId")
       id AS keeper_id, "tenantId", "userId"
FROM drivers
WHERE "userId" IS NOT NULL
ORDER BY "tenantId", "userId", "createdAt" ASC, id ASC;

-- 2. Everything that points at a duplicate now points at the keeper. Orders
--    keep their delivery history rather than losing it with the row.
UPDATE driver_assignments a
SET "driverId" = k.keeper_id
FROM drivers d
JOIN driver_keepers k
  ON k."tenantId" = d."tenantId" AND k."userId" = d."userId"
WHERE a."driverId" = d.id
  AND d.id <> k.keeper_id;

UPDATE driver_cash_ups c
SET "driverId" = k.keeper_id
FROM drivers d
JOIN driver_keepers k
  ON k."tenantId" = d."tenantId" AND k."userId" = d."userId"
WHERE c."driverId" = d.id
  AND d.id <> k.keeper_id;

-- 3. Presence is one row per driver. Give the keeper the duplicate's presence
--    only when it has none of its own — that row carries the push token the
--    phone registered, and throwing it away would silence job alerts until the
--    driver next opens the app.
UPDATE driver_presence p
SET "driverId" = k.keeper_id
FROM drivers d
JOIN driver_keepers k
  ON k."tenantId" = d."tenantId" AND k."userId" = d."userId"
WHERE p."driverId" = d.id
  AND d.id <> k.keeper_id
  AND NOT EXISTS (SELECT 1 FROM driver_presence q WHERE q."driverId" = k.keeper_id);

-- 4. The duplicates are now unreferenced. driver_presence and driver_cash_ups
--    cascade; driver_assignments were re-pointed above, so nothing restricts.
DELETE FROM drivers d
USING driver_keepers k
WHERE k."tenantId" = d."tenantId"
  AND k."userId" = d."userId"
  AND d.id <> k.keeper_id;

DROP TABLE driver_keepers;

-- 5. Make it impossible to repeat.
--
--    Not a partial index: Postgres treats NULLs as distinct in a unique index,
--    so operator-created rows with no login are already unconstrained and can
--    be as many as a shop likes. A plain index also matches exactly what
--    @@unique([tenantId, userId]) generates, so the schema and the database
--    agree and no drift is left behind.
CREATE UNIQUE INDEX IF NOT EXISTS "drivers_tenantId_userId_key"
  ON drivers ("tenantId", "userId");
