-- Table Service Phase 2/3 — floor plan, availability, QR at table,
-- covers/server, and reservations.
--
-- Every column is additive with a default, so existing tables keep
-- working untouched: unplaced tables (posX/posY NULL) fall back to the
-- flat area/sortOrder list, and every table starts bookable + in service.

-- ── Floor plan ──────────────────────────────────────────────────────
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "posX" INTEGER;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "posY" INTEGER;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "shape" TEXT NOT NULL DEFAULT 'SQUARE';
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "width" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "height" INTEGER NOT NULL DEFAULT 1;

-- ── Availability ────────────────────────────────────────────────────
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "bookableOnline" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "outOfService" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "outOfServiceNote" TEXT;

-- ── QR at table ─────────────────────────────────────────────────────
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "qrToken" TEXT;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "qrEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "tables_qrToken_key" ON "tables"("qrToken");

-- ── Current sitting ─────────────────────────────────────────────────
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "covers" INTEGER;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "serverId" TEXT;
ALTER TABLE "tables" ADD COLUMN IF NOT EXISTS "serverName" TEXT;

-- Covers snapshot on the order, so spend-per-head survives the table
-- being freed and re-seated.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "covers" INTEGER;

-- ── Reservations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "table_reservations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "tableId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "partySize" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMins" INTEGER NOT NULL DEFAULT 90,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "source" TEXT NOT NULL DEFAULT 'STAFF',
    "notes" TEXT,
    "orderId" TEXT,
    "seatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "table_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "table_reservations_reference_key" ON "table_reservations"("reference");
CREATE INDEX IF NOT EXISTS "table_reservations_tenantId_idx" ON "table_reservations"("tenantId");
CREATE INDEX IF NOT EXISTS "table_reservations_locationId_startsAt_idx" ON "table_reservations"("locationId", "startsAt");
CREATE INDEX IF NOT EXISTS "table_reservations_tableId_idx" ON "table_reservations"("tableId");
CREATE INDEX IF NOT EXISTS "table_reservations_status_idx" ON "table_reservations"("status");

DO $$ BEGIN
  ALTER TABLE "table_reservations" ADD CONSTRAINT "table_reservations_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "table_reservations" ADD CONSTRAINT "table_reservations_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
