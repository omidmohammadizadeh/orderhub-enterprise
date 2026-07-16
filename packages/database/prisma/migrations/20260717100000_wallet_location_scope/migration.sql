-- Location-scope the SMS wallet: one wallet per (tenant, location).

ALTER TABLE "wallets" ADD COLUMN "locationId" TEXT;

-- Swap tenant-only uniqueness for (tenant, location). Existing rows keep
-- locationId NULL = the tenant-wide wallet.
DROP INDEX IF EXISTS "wallets_tenantId_key";
CREATE UNIQUE INDEX "wallets_tenantId_locationId_key" ON "wallets"("tenantId", "locationId");
