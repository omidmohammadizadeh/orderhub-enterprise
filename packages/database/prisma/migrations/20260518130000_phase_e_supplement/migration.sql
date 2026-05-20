-- Phase E Supplement: missing enum types and columns
-- These were defined in schema.prisma but omitted from the original phase_e migration.
-- Must run after 20260518120000_phase_e and before 20260518180000_phase_f,
-- which uses ALTER TYPE "OrderSource" ADD VALUE and assumes the type already exists.

-- ── Missing enum types ────────────────────────────────────────────────────────
CREATE TYPE "OrderSource" AS ENUM (
  'ONLINE', 'POS', 'UBER_EATS', 'DELIVEROO', 'JUST_EAT',
  'HUBRISE', 'DIRECT', 'TALABAT', 'DOORDASH', 'GRUBHUB', 'CAREEM'
);
CREATE TYPE "IntegrationSource" AS ENUM ('DIRECT', 'HUBRISE');
CREATE TYPE "FulfillmentType" AS ENUM (
  'PICKUP', 'DELIVERY', 'DINE_IN', 'MERCHANT_DELIVERY', 'PLATFORM_COURIER'
);
CREATE TYPE "OrderStatusActorType" AS ENUM ('STAFF', 'SYSTEM', 'WEBHOOK', 'API', 'KIOSK');
CREATE TYPE "PrinterConnectionType" AS ENUM (
  'USB', 'LAN', 'BLUETOOTH', 'EPSON_EPOS', 'STAR', 'CLOUD'
);
CREATE TYPE "PrinterStation" AS ENUM (
  'KITCHEN', 'FRONT_COUNTER', 'BAR', 'LABELS', 'DISPATCH'
);

-- ── Missing columns on orders ─────────────────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN "orderSource"       "OrderSource"       NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "orders" ADD COLUMN "integrationSource" "IntegrationSource" NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "orders" ADD COLUMN "viaHubrise"        BOOLEAN             NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "fulfillmentType"   "FulfillmentType"   NOT NULL DEFAULT 'DELIVERY';
CREATE INDEX "orders_tenantId_orderSource_idx"   ON "orders"("tenantId", "orderSource");
CREATE INDEX "orders_locationId_orderSource_idx" ON "orders"("locationId", "orderSource");
CREATE INDEX "orders_orderSource_idx"            ON "orders"("orderSource");
CREATE INDEX "orders_integrationSource_idx"      ON "orders"("integrationSource");

-- ── Missing column on order_status_history ───────────────────────────────────
ALTER TABLE "order_status_history" ADD COLUMN "actorType" "OrderStatusActorType" NOT NULL DEFAULT 'SYSTEM';

-- ── Missing columns on printers ──────────────────────────────────────────────
ALTER TABLE "printers" ADD COLUMN "connectionType" "PrinterConnectionType" NOT NULL DEFAULT 'LAN';
ALTER TABLE "printers" ADD COLUMN "station"        "PrinterStation"        NOT NULL DEFAULT 'KITCHEN';
CREATE INDEX "printers_locationId_station_idx" ON "printers"("locationId", "station");
