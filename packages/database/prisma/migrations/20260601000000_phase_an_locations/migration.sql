-- Phase AN — Locations + Brands + BrandPlatformConnection.
--
-- Additive, idempotent. Adds structured columns to locations + brand
-- description/cuisine + new brand_platform_connections table.

-- ── locations ──
ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "about"                     TEXT,
  ADD COLUMN IF NOT EXISTS "logoUrl"                   TEXT,
  ADD COLUMN IF NOT EXISTS "customDomain"              TEXT,
  ADD COLUMN IF NOT EXISTS "customDomainStatus"        TEXT NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS "onlineOrderingSlug"        TEXT,
  ADD COLUMN IF NOT EXISTS "stripeConnectedAccountId"  TEXT,
  ADD COLUMN IF NOT EXISTS "applicationFeeFixedAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "applicationFeePercentage"  DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "applicationFeeMode"        TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "addressLine1"              TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine2"              TEXT,
  ADD COLUMN IF NOT EXISTS "city"                      TEXT,
  ADD COLUMN IF NOT EXISTS "postcode"                  TEXT,
  ADD COLUMN IF NOT EXISTS "country"                   TEXT NOT NULL DEFAULT 'GB',
  ADD COLUMN IF NOT EXISTS "status"                    TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "busyModeJson"              JSONB NOT NULL DEFAULT '{}';

-- Backfill structured address columns from the legacy address JSON
UPDATE "locations" SET
  "addressLine1" = COALESCE("addressLine1", address->>'line1'),
  "addressLine2" = COALESCE("addressLine2", address->>'line2'),
  "city"         = COALESCE("city",         address->>'city'),
  "postcode"     = COALESCE("postcode",     address->>'postcode'),
  "country"      = COALESCE("country",      address->>'country', 'GB')
WHERE address IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "locations_onlineOrderingSlug_key"
  ON "locations"("onlineOrderingSlug")
  WHERE "onlineOrderingSlug" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "locations_customDomain_idx" ON "locations"("customDomain");

-- ── brands ──
ALTER TABLE "brands"
  ADD COLUMN IF NOT EXISTS "description"  TEXT,
  ADD COLUMN IF NOT EXISTS "cuisine"      TEXT,
  ADD COLUMN IF NOT EXISTS "isSuspended"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "primaryLocationId" TEXT;

-- A virtual brand can be primary-scoped to a specific location (ghost-kitchen
-- model). The existing brand→location 1:M relation continues to model
-- franchises. If primaryLocationId is null the brand spans all locations.
CREATE INDEX IF NOT EXISTS "brands_primaryLocationId_idx" ON "brands"("primaryLocationId");

-- ── brand_platform_connections ──
CREATE TABLE IF NOT EXISTS "brand_platform_connections" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "brandId"       TEXT NOT NULL,
  "locationId"    TEXT NOT NULL,
  "platform"      TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'not_connected',
  "externalStoreId" TEXT,
  "externalBrandId" TEXT,
  "integrationId" TEXT,
  "lastSyncAt"    TIMESTAMP(3),
  "lastWebhookAt" TIMESTAMP(3),
  "lastError"     TEXT,
  "metadata"      JSONB NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "brand_platform_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_platform_connections_brand_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE,
  CONSTRAINT "brand_platform_connections_location_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "brand_platform_connections_unique"
  ON "brand_platform_connections"("brandId", "locationId", "platform");
CREATE INDEX IF NOT EXISTS "brand_platform_connections_tenant_idx"
  ON "brand_platform_connections"("tenantId");
CREATE INDEX IF NOT EXISTS "brand_platform_connections_location_idx"
  ON "brand_platform_connections"("locationId");
