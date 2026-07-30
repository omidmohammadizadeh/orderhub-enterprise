-- Kiosk devices + the explicit walk-in tag.
--
-- Additive and IF NOT EXISTS throughout, so it is safe to re-run and needs
-- no backfill: existing orders are simply not walk-ins.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "isWalkIn" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "orders_isWalkIn_idx" ON "orders"("isWalkIn");

CREATE TABLE IF NOT EXISTS "kiosk_devices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "brandId" TEXT,
    "name" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kiosk_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "kiosk_devices_publicToken_key" ON "kiosk_devices"("publicToken");
CREATE INDEX IF NOT EXISTS "kiosk_devices_tenantId_idx" ON "kiosk_devices"("tenantId");
CREATE INDEX IF NOT EXISTS "kiosk_devices_locationId_idx" ON "kiosk_devices"("locationId");

DO $$ BEGIN
  ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
