-- Phase BH — Stuart last-mile courier dispatch.

-- Courier provider + external job id on the order (reuses existing courier_* columns).
ALTER TABLE "orders" ADD COLUMN "courierProvider" TEXT;
ALTER TABLE "orders" ADD COLUMN "courierJobId" TEXT;

-- Link a wallet debit to the dispatched order (DISPATCH_FEE reconciliation).
ALTER TABLE "wallet_transactions" ADD COLUMN "orderId" TEXT;

-- Per-location Stuart config.
CREATE TABLE "stuart_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "credentials" JSONB NOT NULL,
    "webhookAuthKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stuart_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stuart_configs_locationId_key" ON "stuart_configs"("locationId");

ALTER TABLE "stuart_configs"
    ADD CONSTRAINT "stuart_configs_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fast lookup of the order a Stuart webhook refers to.
CREATE INDEX "orders_courierJobId_idx" ON "orders"("courierJobId");
