-- Phase AS-4 — alert configuration + per-station overrides.
--
-- One AlertConfig per (location, trigger) tuple. Drives the dashboard
-- sound + visual notification pipeline. Triggers cover both order
-- lifecycle events (NEW_ORDER / ORDER_CANCELLED / RIDER_ARRIVED /
-- SCHEDULED_ORDER_READY) and printer health events (PRINTER_OFFLINE /
-- FAILED_PRINT). Optional stationId narrows the rule to a single
-- kitchen station so the pizza screen doesn't bing for grill orders.

CREATE TYPE "AlertTrigger" AS ENUM (
  'NEW_ORDER',
  'ORDER_CANCELLED',
  'RIDER_ARRIVED',
  'SCHEDULED_ORDER_READY',
  'PRINTER_OFFLINE',
  'FAILED_PRINT'
);

CREATE TABLE "alert_configs" (
  "id"                     TEXT NOT NULL,
  "tenantId"               TEXT NOT NULL,
  "locationId"             TEXT NOT NULL,
  "stationId"              TEXT,
  "trigger"                "AlertTrigger" NOT NULL,
  "enabled"                BOOLEAN NOT NULL DEFAULT TRUE,
  "soundUrl"               TEXT,
  "volume"                 DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "repeatCount"            INTEGER NOT NULL DEFAULT 1,
  "repeatIntervalMs"       INTEGER NOT NULL DEFAULT 5000,
  "autoStopSeconds"        INTEGER,
  "requireAcknowledgement" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "alert_configs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "alert_configs_tenantId_idx"   ON "alert_configs"("tenantId");
CREATE INDEX "alert_configs_locationId_idx" ON "alert_configs"("locationId");
CREATE UNIQUE INDEX "alert_configs_loc_station_trigger_key"
  ON "alert_configs"("locationId", COALESCE("stationId", ''), "trigger");

ALTER TABLE "alert_configs"
  ADD CONSTRAINT "alert_configs_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "alert_configs"
  ADD CONSTRAINT "alert_configs_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;
ALTER TABLE "alert_configs"
  ADD CONSTRAINT "alert_configs_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "printer_stations"("id") ON DELETE CASCADE;

-- Acknowledgement log — when a user clicks "Stop" on a repeating
-- alert, we record it so the same alert doesn't keep ringing for
-- everyone on the location.
CREATE TABLE "alert_acks" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "locationId"   TEXT NOT NULL,
  "trigger"      "AlertTrigger" NOT NULL,
  "referenceKey" TEXT NOT NULL,
  "acknowledgedById" TEXT,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_acks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "alert_acks_locationId_idx" ON "alert_acks"("locationId");
CREATE UNIQUE INDEX "alert_acks_referenceKey_key" ON "alert_acks"("referenceKey");
