-- Phase AX — Dispatch foundation
-- Adds geocode cache columns to orders and the driver_presence table.
-- Fully idempotent: safe to re-run (matches the project's hand-written
-- migration convention).

-- ── orders: geocoded delivery coordinates ────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveryLat" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveryLng" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "geocodedAt" TIMESTAMP(3);

-- ── DriverPresenceStatus enum ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "DriverPresenceStatus" AS ENUM ('OFFLINE', 'ONLINE', 'ON_JOB');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── driver_presence table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "driver_presence" (
  "id"                 TEXT NOT NULL,
  "driverId"           TEXT NOT NULL,
  "tenantId"           TEXT NOT NULL,
  "locationId"         TEXT,
  "status"             "DriverPresenceStatus" NOT NULL DEFAULT 'OFFLINE',
  "lat"                DOUBLE PRECISION,
  "lng"                DOUBLE PRECISION,
  "heading"            DOUBLE PRECISION,
  "speed"              DOUBLE PRECISION,
  "activeAssignmentId" TEXT,
  "socketId"           TEXT,
  "pushToken"          TEXT,
  "lastPingAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_presence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "driver_presence_driverId_key"
  ON "driver_presence" ("driverId");
CREATE INDEX IF NOT EXISTS "driver_presence_tenantId_status_idx"
  ON "driver_presence" ("tenantId", "status");
CREATE INDEX IF NOT EXISTS "driver_presence_tenantId_locationId_status_idx"
  ON "driver_presence" ("tenantId", "locationId", "status");

DO $$ BEGIN
  ALTER TABLE "driver_presence"
    ADD CONSTRAINT "driver_presence_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
