-- Phase BK — Yango Delivery (UAE) courier dispatch, per location. Same shape as
-- jet_go_configs, plus the two things Yango needs: a stored pickup point (Yango
-- takes coordinates and Location has none) and a `mode` that defaults to
-- estimate_only, because Yango has no sandbox and accepting a claim sends a real
-- courier.

CREATE TABLE "yango_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'estimate_only',
    "credentials" JSONB NOT NULL,
    "taxiClass" TEXT NOT NULL DEFAULT 'courier',
    "contactEmail" TEXT,
    "pickupLat" DOUBLE PRECISION,
    "pickupLng" DOUBLE PRECISION,
    "webhookToken" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "yango_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "yango_configs_locationId_key" ON "yango_configs"("locationId");
CREATE INDEX "yango_configs_tenantId_idx" ON "yango_configs"("tenantId");
-- The inbound callback looks a config up by this token.
CREATE INDEX "yango_configs_webhookToken_idx" ON "yango_configs"("webhookToken");

ALTER TABLE "yango_configs"
    ADD CONSTRAINT "yango_configs_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
