-- Phase AS-1 — Print engine architecture (schema only).
--
-- This migration is **idempotent** — every statement is safe to re-run.
-- That's important because an earlier attempt partially applied on prod
-- and crashed midway; Prisma's _prisma_migrations table marked it
-- failed, and after marking the record rolled-back the retry must
-- tolerate the partial state.

-- ────────────────────────────────────────────────────────────────
-- printers.tenantId backfill (init migration missed it)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "printers" p
SET "tenantId" = b."tenantId"
FROM "locations" l
JOIN "brands" b ON b."id" = l."brandId"
WHERE p."locationId" = l."id" AND p."tenantId" IS NULL;

-- ALTER ... SET NOT NULL is a no-op when already NOT NULL.
ALTER TABLE "printers" ALTER COLUMN "tenantId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "printers_tenantId_idx" ON "printers"("tenantId");

-- ────────────────────────────────────────────────────────────────
-- Enum renames (PrinterStation → PrinterStationKind)
-- ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PrinterStation')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PrinterStationKind') THEN
    ALTER TYPE "PrinterStation" RENAME TO "PrinterStationKind";
  END IF;
END $$;

ALTER TYPE "PrinterStationKind" ADD VALUE IF NOT EXISTS 'EXPO';
ALTER TYPE "PrinterStationKind" ADD VALUE IF NOT EXISTS 'OTHER';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'printers' AND column_name = 'station'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'printers' AND column_name = 'kind'
  ) THEN
    ALTER TABLE "printers" RENAME COLUMN "station" TO "kind";
  END IF;
END $$;

-- PrintJobType / PrintJobStatus extensions (additive, already idempotent).
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'CUSTOMER_RECEIPT';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'DRIVER_SLIP';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'DISPATCH_TICKET';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'TEST_PRINT';

ALTER TYPE "PrintJobStatus" ADD VALUE IF NOT EXISTS 'CLAIMED';

-- New enums (only create when missing).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PrintTrigger') THEN
    CREATE TYPE "PrintTrigger" AS ENUM (
      'ORDER_RECEIVED', 'ORDER_ACCEPTED', 'ORDER_PREPARING',
      'ORDER_READY', 'MANUAL_ONLY'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PrintAgentKind') THEN
    CREATE TYPE "PrintAgentKind" AS ENUM (
      'WEB_BRIDGE', 'FLUTTER_MOBILE', 'FLUTTER_DESKTOP', 'SERVER_DIRECT'
    );
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- PrinterStation rows
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "printer_stations" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "kind"             "PrinterStationKind" NOT NULL DEFAULT 'KITCHEN',
  "defaultPrinterId" TEXT,
  "isActive"         BOOLEAN NOT NULL DEFAULT TRUE,
  "sortOrder"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "printer_stations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "printer_stations_tenantId_idx"   ON "printer_stations"("tenantId");
CREATE INDEX IF NOT EXISTS "printer_stations_locationId_idx" ON "printer_stations"("locationId");
CREATE UNIQUE INDEX IF NOT EXISTS "printer_stations_locationId_name_key" ON "printer_stations"("locationId", "name");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printer_stations_tenantId_fkey') THEN
    ALTER TABLE "printer_stations" ADD CONSTRAINT "printer_stations_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printer_stations_locationId_fkey') THEN
    ALTER TABLE "printer_stations" ADD CONSTRAINT "printer_stations_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printer_stations_defaultPrinterId_fkey') THEN
    ALTER TABLE "printer_stations" ADD CONSTRAINT "printer_stations_defaultPrinterId_fkey"
      FOREIGN KEY ("defaultPrinterId") REFERENCES "printers"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- Routing join tables
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "menu_item_stations" (
  "id"         TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "stationId"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "menu_item_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_stations_menuItemId_stationId_key"
  ON "menu_item_stations"("menuItemId", "stationId");
CREATE INDEX IF NOT EXISTS "menu_item_stations_menuItemId_idx" ON "menu_item_stations"("menuItemId");
CREATE INDEX IF NOT EXISTS "menu_item_stations_stationId_idx" ON "menu_item_stations"("stationId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_item_stations_menuItemId_fkey') THEN
    ALTER TABLE "menu_item_stations" ADD CONSTRAINT "menu_item_stations_menuItemId_fkey"
      FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_item_stations_stationId_fkey') THEN
    ALTER TABLE "menu_item_stations" ADD CONSTRAINT "menu_item_stations_stationId_fkey"
      FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "modifier_group_stations" (
  "id"              TEXT NOT NULL,
  "modifierGroupId" TEXT NOT NULL,
  "stationId"       TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "modifier_group_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "modifier_group_stations_modifierGroupId_stationId_key"
  ON "modifier_group_stations"("modifierGroupId", "stationId");
CREATE INDEX IF NOT EXISTS "modifier_group_stations_modifierGroupId_idx" ON "modifier_group_stations"("modifierGroupId");
CREATE INDEX IF NOT EXISTS "modifier_group_stations_stationId_idx" ON "modifier_group_stations"("stationId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'modifier_group_stations_modifierGroupId_fkey') THEN
    ALTER TABLE "modifier_group_stations" ADD CONSTRAINT "modifier_group_stations_modifierGroupId_fkey"
      FOREIGN KEY ("modifierGroupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'modifier_group_stations_stationId_fkey') THEN
    ALTER TABLE "modifier_group_stations" ADD CONSTRAINT "modifier_group_stations_stationId_fkey"
      FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "menu_category_stations" (
  "id"         TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "stationId"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "menu_category_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "menu_category_stations_categoryId_stationId_key"
  ON "menu_category_stations"("categoryId", "stationId");
CREATE INDEX IF NOT EXISTS "menu_category_stations_categoryId_idx" ON "menu_category_stations"("categoryId");
CREATE INDEX IF NOT EXISTS "menu_category_stations_stationId_idx" ON "menu_category_stations"("stationId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_category_stations_categoryId_fkey') THEN
    ALTER TABLE "menu_category_stations" ADD CONSTRAINT "menu_category_stations_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_category_stations_stationId_fkey') THEN
    ALTER TABLE "menu_category_stations" ADD CONSTRAINT "menu_category_stations_stationId_fkey"
      FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- Brand / Location routing defaults
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "defaultStationId" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brands_defaultStationId_fkey') THEN
    ALTER TABLE "brands" ADD CONSTRAINT "brands_defaultStationId_fkey"
      FOREIGN KEY ("defaultStationId") REFERENCES "printer_stations"("id") ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "defaultKitchenStationId" TEXT,
  ADD COLUMN IF NOT EXISTS "receiptPrinterId"        TEXT,
  ADD COLUMN IF NOT EXISTS "dispatchPrinterId"       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_defaultKitchenStationId_fkey') THEN
    ALTER TABLE "locations" ADD CONSTRAINT "locations_defaultKitchenStationId_fkey"
      FOREIGN KEY ("defaultKitchenStationId") REFERENCES "printer_stations"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_receiptPrinterId_fkey') THEN
    ALTER TABLE "locations" ADD CONSTRAINT "locations_receiptPrinterId_fkey"
      FOREIGN KEY ("receiptPrinterId") REFERENCES "printers"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_dispatchPrinterId_fkey') THEN
    ALTER TABLE "locations" ADD CONSTRAINT "locations_dispatchPrinterId_fkey"
      FOREIGN KEY ("dispatchPrinterId") REFERENCES "printers"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- Printer additions
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "printers"
  ADD COLUMN IF NOT EXISTS "agentId"    TEXT,
  ADD COLUMN IF NOT EXISTS "model"      TEXT,
  ADD COLUMN IF NOT EXISTS "paperWidth" INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS "defaults"   JSONB NOT NULL DEFAULT '{}'::JSONB;
CREATE INDEX IF NOT EXISTS "printers_agentId_idx" ON "printers"("agentId");

-- ────────────────────────────────────────────────────────────────
-- PrintAgent
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "print_agents" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "locationId"    TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "kind"          "PrintAgentKind" NOT NULL DEFAULT 'WEB_BRIDGE',
  "apiTokenHash"  TEXT NOT NULL,
  "capabilities"  JSONB NOT NULL DEFAULT '{}'::JSONB,
  "versionString" TEXT,
  "lastSeenAt"    TIMESTAMP(3),
  "isActive"      BOOLEAN NOT NULL DEFAULT TRUE,
  "deletedAt"     TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "print_agents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "print_agents_tenantId_idx"   ON "print_agents"("tenantId");
CREATE INDEX IF NOT EXISTS "print_agents_locationId_idx" ON "print_agents"("locationId");
CREATE INDEX IF NOT EXISTS "print_agents_lastSeenAt_idx" ON "print_agents"("lastSeenAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agents_tenantId_fkey') THEN
    ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agents_locationId_fkey') THEN
    ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_agentId_fkey') THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_agentId_fkey"
      FOREIGN KEY ("agentId") REFERENCES "print_agents"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- PrintJob additions
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "stationId"        TEXT,
  ADD COLUMN IF NOT EXISTS "trigger"          "PrintTrigger",
  ADD COLUMN IF NOT EXISTS "claimedByAgentId" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "routeKey"         TEXT,
  ADD COLUMN IF NOT EXISTS "idempotencyKey"   TEXT,
  ADD COLUMN IF NOT EXISTS "copies"           INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_stationId_fkey') THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_stationId_fkey"
      FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_claimedByAgentId_fkey') THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_claimedByAgentId_fkey"
      FOREIGN KEY ("claimedByAgentId") REFERENCES "print_agents"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_idempotencyKey_key"
  ON "print_jobs"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- NB: this index intentionally omits a partial-WHERE clause. Postgres
-- forbids referencing newly-added enum values (e.g. CLAIMED, added a
-- few lines above) in the same transaction, and Prisma wraps each
-- migration in one transaction. A plain compound index still serves
-- the agent-claim hot path; if profiling later shows it costs too
-- much disk, a follow-up migration can replace it with a partial
-- index now that CLAIMED is committed.
CREATE INDEX IF NOT EXISTS "print_jobs_status_routeKey_idx"
  ON "print_jobs"("status", "routeKey");

CREATE INDEX IF NOT EXISTS "print_jobs_claimedByAgentId_idx" ON "print_jobs"("claimedByAgentId");
CREATE INDEX IF NOT EXISTS "print_jobs_stationId_idx"        ON "print_jobs"("stationId");
