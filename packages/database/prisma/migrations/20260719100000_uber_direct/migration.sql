-- Phase BI — Uber Direct last-mile courier dispatch (per location).

CREATE TABLE "uber_direct_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "credentials" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uber_direct_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uber_direct_configs_locationId_key" ON "uber_direct_configs"("locationId");

ALTER TABLE "uber_direct_configs"
    ADD CONSTRAINT "uber_direct_configs_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
