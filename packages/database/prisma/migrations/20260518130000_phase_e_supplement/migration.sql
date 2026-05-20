-- Phase E Supplement: missing enum types and columns
-- These were defined in schema.prisma but omitted from earlier migration files.
-- Runs after 20260518120000_phase_e (applied) and before 20260518180000_phase_f.

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
-- tenantId was omitted from the init migration orders CREATE TABLE
ALTER TABLE "orders" ADD COLUMN "tenantId"         TEXT NOT NULL DEFAULT '';
ALTER TABLE "orders" ADD COLUMN "customerName"     TEXT;
ALTER TABLE "orders" ADD COLUMN "customerPhone"    TEXT;
ALTER TABLE "orders" ADD COLUMN "idempotencyKey"   TEXT;
ALTER TABLE "orders" ADD COLUMN "preparingAt"      TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "outForDeliveryAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "deliveredAt"      TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "receivedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "orders" ADD COLUMN "sourceMetadata"   JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "orders" ADD COLUMN "orderSource"       "OrderSource"       NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "orders" ADD COLUMN "integrationSource" "IntegrationSource" NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "orders" ADD COLUMN "viaHubrise"        BOOLEAN             NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "fulfillmentType"   "FulfillmentType"   NOT NULL DEFAULT 'DELIVERY';

CREATE UNIQUE INDEX "orders_idempotencyKey_key"      ON "orders"("idempotencyKey");
CREATE INDEX "orders_tenantId_createdAt_idx"         ON "orders"("tenantId", "createdAt" DESC);
CREATE INDEX "orders_tenantId_status_idx"            ON "orders"("tenantId", "status");
CREATE INDEX "orders_tenantId_locationId_idx"        ON "orders"("tenantId", "locationId");
CREATE INDEX "orders_tenantId_orderSource_idx"       ON "orders"("tenantId", "orderSource");
CREATE INDEX "orders_locationId_orderSource_idx"     ON "orders"("locationId", "orderSource");
CREATE INDEX "orders_orderSource_idx"                ON "orders"("orderSource");
CREATE INDEX "orders_integrationSource_idx"          ON "orders"("integrationSource");
CREATE INDEX "orders_tenantId_customerPhone_idx"     ON "orders"("tenantId", "customerPhone");
CREATE INDEX "orders_tenantId_customerName_idx"      ON "orders"("tenantId", "customerName");

-- ── Missing column on order_status_history ───────────────────────────────────
ALTER TABLE "order_status_history" ADD COLUMN "actorType" "OrderStatusActorType" NOT NULL DEFAULT 'SYSTEM';

-- ── Missing columns on printers ──────────────────────────────────────────────
ALTER TABLE "printers" ADD COLUMN "connectionType" "PrinterConnectionType" NOT NULL DEFAULT 'LAN';
ALTER TABLE "printers" ADD COLUMN "station"        "PrinterStation"        NOT NULL DEFAULT 'KITCHEN';
CREATE INDEX "printers_locationId_station_idx" ON "printers"("locationId", "station");
