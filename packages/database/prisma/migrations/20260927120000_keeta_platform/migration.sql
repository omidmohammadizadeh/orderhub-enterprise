-- Phase KT — direct Keeta (Meituan) integration.
--
-- Keeta orders are written with platform/source "KEETA". A NEW migration,
-- deliberately: editing an already-shipped one changes its checksum and the
-- API refuses to boot. ADD VALUE IF NOT EXISTS keeps it re-runnable.
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'KEETA';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'KEETA';
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'KEETA';

-- One row per Keeta brand authorization. Keeta's refresh tokens are
-- single-use, so the token lives here once rather than on every store's
-- connection row.
CREATE TABLE IF NOT EXISTS "keeta_authorizations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "keetaBrandId" TEXT,
    "brandName" TEXT,
    "keetaUserId" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "shops" JSONB NOT NULL DEFAULT '[]',
    "lastRefreshAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "keeta_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "keeta_authorizations_tenantId_keetaBrandId_key"
    ON "keeta_authorizations"("tenantId", "keetaBrandId");
CREATE INDEX IF NOT EXISTS "keeta_authorizations_tenantId_idx"
    ON "keeta_authorizations"("tenantId");
