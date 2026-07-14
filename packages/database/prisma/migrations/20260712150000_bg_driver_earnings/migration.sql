-- Phase BG — driver earnings + cash-up.
ALTER TABLE "drivers"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "startupFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "postcodeFees" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX "drivers_locationId_idx" ON "drivers"("locationId");

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "driver_cash_ups" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "locationId" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "cashOrders" INTEGER NOT NULL DEFAULT 0,
  "cashCollected" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "cardOrders" INTEGER NOT NULL DEFAULT 0,
  "cardCollected" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "deliveries" INTEGER NOT NULL DEFAULT 0,
  "driverEarning" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "cashHandover" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_cash_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "driver_cash_ups_tenantId_driverId_periodEnd_idx" ON "driver_cash_ups"("tenantId", "driverId", "periodEnd");

ALTER TABLE "driver_cash_ups"
  ADD CONSTRAINT "driver_cash_ups_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
