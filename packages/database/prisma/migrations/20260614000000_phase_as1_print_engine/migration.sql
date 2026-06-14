-- Phase AS-1 — Print engine architecture (schema only, no UI).
--
-- Adds first-class PrinterStation rows (replacing the enum-only model),
-- product/category/modifier-group → station routing tables, a PrintAgent
-- model for client devices that physically drive printers, and lifecycle
-- additions on PrintJob (claim semantics, idempotency, station + trigger
-- tagging). Keeps the existing `printers` and `print_jobs` tables in
-- place — additive only.

-- ────────────────────────────────────────────────────────────────
-- Safety net: the init migration missed `printers.tenantId` on prod.
-- Idempotently add it now so future joins work, and backfill from the
-- printer's location.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "printers"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "printers" p
SET "tenantId" = b."tenantId"
FROM "locations" l
JOIN "brands" b ON b."id" = l."brandId"
WHERE p."locationId" = l."id"
  AND p."tenantId" IS NULL;

-- Don't enforce NOT NULL until every row has it. After backfill above,
-- safe to constrain.
ALTER TABLE "printers" ALTER COLUMN "tenantId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "printers_tenantId_idx" ON "printers"("tenantId");

-- ────────────────────────────────────────────────────────────────
-- Enum renames + extensions
-- ────────────────────────────────────────────────────────────────

-- The old enum `PrinterStation` becomes `PrinterStationKind` to make room
-- for the row-shaped model with the same human name. Existing
-- printers.station column gets renamed to `kind`.
ALTER TYPE "PrinterStation" RENAME TO "PrinterStationKind";

-- Add the kinds the operator described (BAR_LABELS, EXPO).
ALTER TYPE "PrinterStationKind" ADD VALUE IF NOT EXISTS 'EXPO';
ALTER TYPE "PrinterStationKind" ADD VALUE IF NOT EXISTS 'OTHER';

ALTER TABLE "printers" RENAME COLUMN "station" TO "kind";

-- PrintJobType: add the new typed names the operator picked. Keep the
-- old names as deprecated aliases so existing rows / code don't break.
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'CUSTOMER_RECEIPT';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'DRIVER_SLIP';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'DISPATCH_TICKET';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'TEST_PRINT';

-- PrintJobStatus: add the CLAIMED state that sits between QUEUED and
-- PRINTING. Agents call /claim → CLAIMED, /start → PRINTING.
ALTER TYPE "PrintJobStatus" ADD VALUE IF NOT EXISTS 'CLAIMED';

-- PrintTrigger — new enum driving auto-print rule timing.
CREATE TYPE "PrintTrigger" AS ENUM (
  'ORDER_RECEIVED',
  'ORDER_ACCEPTED',
  'ORDER_PREPARING',
  'ORDER_READY',
  'MANUAL_ONLY'
);

-- PrintAgentKind — which runtime is connecting (web bridge, mobile, …).
CREATE TYPE "PrintAgentKind" AS ENUM (
  'WEB_BRIDGE',
  'FLUTTER_MOBILE',
  'FLUTTER_DESKTOP',
  'SERVER_DIRECT'
);

-- ────────────────────────────────────────────────────────────────
-- New model: PrinterStation (rows replacing the enum-only model)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE "printer_stations" (
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
CREATE INDEX "printer_stations_tenantId_idx"
  ON "printer_stations"("tenantId");
CREATE INDEX "printer_stations_locationId_idx"
  ON "printer_stations"("locationId");
CREATE UNIQUE INDEX "printer_stations_locationId_name_key"
  ON "printer_stations"("locationId", "name");
ALTER TABLE "printer_stations"
  ADD CONSTRAINT "printer_stations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "printer_stations"
  ADD CONSTRAINT "printer_stations_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;
ALTER TABLE "printer_stations"
  ADD CONSTRAINT "printer_stations_defaultPrinterId_fkey"
  FOREIGN KEY ("defaultPrinterId") REFERENCES "printers"("id") ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- Routing join tables (most-specific wins resolver)
-- ────────────────────────────────────────────────────────────────

-- Menu item → station (highest priority override).
CREATE TABLE "menu_item_stations" (
  "id"         TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "stationId"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "menu_item_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "menu_item_stations_menuItemId_stationId_key"
  ON "menu_item_stations"("menuItemId", "stationId");
CREATE INDEX "menu_item_stations_menuItemId_idx"
  ON "menu_item_stations"("menuItemId");
CREATE INDEX "menu_item_stations_stationId_idx"
  ON "menu_item_stations"("stationId");
ALTER TABLE "menu_item_stations"
  ADD CONSTRAINT "menu_item_stations_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE;
ALTER TABLE "menu_item_stations"
  ADD CONSTRAINT "menu_item_stations_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;

-- Modifier group → station. Routing precedence picks this AFTER item
-- override but BEFORE category fallback, so an "Add ice cream" modifier
-- can prompt a label printer even when the parent item routes elsewhere.
CREATE TABLE "modifier_group_stations" (
  "id"              TEXT NOT NULL,
  "modifierGroupId" TEXT NOT NULL,
  "stationId"       TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "modifier_group_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "modifier_group_stations_modifierGroupId_stationId_key"
  ON "modifier_group_stations"("modifierGroupId", "stationId");
CREATE INDEX "modifier_group_stations_modifierGroupId_idx"
  ON "modifier_group_stations"("modifierGroupId");
CREATE INDEX "modifier_group_stations_stationId_idx"
  ON "modifier_group_stations"("stationId");
ALTER TABLE "modifier_group_stations"
  ADD CONSTRAINT "modifier_group_stations_modifierGroupId_fkey"
  FOREIGN KEY ("modifierGroupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE;
ALTER TABLE "modifier_group_stations"
  ADD CONSTRAINT "modifier_group_stations_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;

-- Category → station.
CREATE TABLE "menu_category_stations" (
  "id"         TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "stationId"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "menu_category_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "menu_category_stations_categoryId_stationId_key"
  ON "menu_category_stations"("categoryId", "stationId");
CREATE INDEX "menu_category_stations_categoryId_idx"
  ON "menu_category_stations"("categoryId");
CREATE INDEX "menu_category_stations_stationId_idx"
  ON "menu_category_stations"("stationId");
ALTER TABLE "menu_category_stations"
  ADD CONSTRAINT "menu_category_stations_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE CASCADE;
ALTER TABLE "menu_category_stations"
  ADD CONSTRAINT "menu_category_stations_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;

-- ────────────────────────────────────────────────────────────────
-- Brand / Location routing defaults
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "brands"
  ADD COLUMN IF NOT EXISTS "defaultStationId" TEXT;
ALTER TABLE "brands"
  ADD CONSTRAINT "brands_defaultStationId_fkey"
  FOREIGN KEY ("defaultStationId") REFERENCES "printer_stations"("id") ON DELETE SET NULL;

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "defaultKitchenStationId" TEXT,
  ADD COLUMN IF NOT EXISTS "receiptPrinterId"        TEXT,
  ADD COLUMN IF NOT EXISTS "dispatchPrinterId"       TEXT;
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_defaultKitchenStationId_fkey"
  FOREIGN KEY ("defaultKitchenStationId") REFERENCES "printer_stations"("id") ON DELETE SET NULL;
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_receiptPrinterId_fkey"
  FOREIGN KEY ("receiptPrinterId") REFERENCES "printers"("id") ON DELETE SET NULL;
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_dispatchPrinterId_fkey"
  FOREIGN KEY ("dispatchPrinterId") REFERENCES "printers"("id") ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- Printer additions
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "printers"
  ADD COLUMN IF NOT EXISTS "agentId"     TEXT,
  ADD COLUMN IF NOT EXISTS "model"       TEXT,
  ADD COLUMN IF NOT EXISTS "paperWidth"  INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS "defaults"    JSONB NOT NULL DEFAULT '{}'::JSONB;
CREATE INDEX IF NOT EXISTS "printers_agentId_idx" ON "printers"("agentId");

-- ────────────────────────────────────────────────────────────────
-- PrintAgent model
-- ────────────────────────────────────────────────────────────────
CREATE TABLE "print_agents" (
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
CREATE INDEX "print_agents_tenantId_idx"   ON "print_agents"("tenantId");
CREATE INDEX "print_agents_locationId_idx" ON "print_agents"("locationId");
CREATE INDEX "print_agents_lastSeenAt_idx" ON "print_agents"("lastSeenAt");
ALTER TABLE "print_agents"
  ADD CONSTRAINT "print_agents_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "print_agents"
  ADD CONSTRAINT "print_agents_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;

ALTER TABLE "printers"
  ADD CONSTRAINT "printers_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "print_agents"("id") ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- PrintJob additions (lifecycle + routing tags + idempotency)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "stationId"         TEXT,
  ADD COLUMN IF NOT EXISTS "trigger"           "PrintTrigger",
  ADD COLUMN IF NOT EXISTS "claimedByAgentId"  TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "routeKey"          TEXT,
  ADD COLUMN IF NOT EXISTS "idempotencyKey"    TEXT,
  ADD COLUMN IF NOT EXISTS "copies"            INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE SET NULL;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_claimedByAgentId_fkey"
  FOREIGN KEY ("claimedByAgentId") REFERENCES "print_agents"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX "print_jobs_idempotencyKey_key"
  ON "print_jobs"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- Hot path: an agent calls /claim and asks "any QUEUED jobs for the
-- printers I own?". This composite covers exactly that filter.
CREATE INDEX "print_jobs_status_routeKey_idx"
  ON "print_jobs"("status", "routeKey")
  WHERE "status" IN ('QUEUED','RETRYING','CLAIMED');

CREATE INDEX "print_jobs_claimedByAgentId_idx"
  ON "print_jobs"("claimedByAgentId");

CREATE INDEX "print_jobs_stationId_idx"
  ON "print_jobs"("stationId");
