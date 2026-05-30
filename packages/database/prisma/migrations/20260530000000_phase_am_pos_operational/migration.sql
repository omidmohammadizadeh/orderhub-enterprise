-- Phase AM — POS Operational Upgrade
--
-- Adds: structured delivery address columns + caller ID + discount metadata +
-- payment provider on Order. New delivery_zones table for per-location
-- postcode-based fee lookup. New location_payment_configs for per-location
-- payment provider selection.
--
-- The PromoCode model already exists and has all the fields we need (type,
-- value, minOrderValue, maxUses, usedCount, startAt, expiresAt, isActive,
-- locationIds). No schema change required there.
--
-- All ADD COLUMN / CREATE TABLE / CREATE INDEX statements are guarded with
-- IF NOT EXISTS so the migration is safe to re-run.

-- ── 1. Order: structured delivery address + caller id + discount/payment metadata
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "addressLine1"     TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine2"     TEXT,
  ADD COLUMN IF NOT EXISTS "city"             TEXT,
  ADD COLUMN IF NOT EXISTS "postcode"         TEXT,
  ADD COLUMN IF NOT EXISTS "callerId"         TEXT,
  ADD COLUMN IF NOT EXISTS "discountType"     TEXT,
  ADD COLUMN IF NOT EXISTS "paymentProvider"  TEXT,
  ADD COLUMN IF NOT EXISTS "scheduledAt"      TIMESTAMP(3);

-- scheduledAt is a deliberate denormalised mirror of scheduledFor. We keep
-- both so existing scheduledFor consumers (webhooks, integrations) keep
-- working while the POS uses scheduledAt as the operator-facing concept.
-- Backfill from scheduledFor where present:
UPDATE "orders" SET "scheduledAt" = "scheduledFor" WHERE "scheduledAt" IS NULL AND "scheduledFor" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "orders_postcode_idx" ON "orders"("postcode");
CREATE INDEX IF NOT EXISTS "orders_callerId_idx" ON "orders"("callerId");
CREATE INDEX IF NOT EXISTS "orders_scheduledAt_idx" ON "orders"("scheduledAt");

-- ── 2. delivery_zones table
CREATE TABLE IF NOT EXISTS "delivery_zones" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "locationId"      TEXT NOT NULL,
  "postcodePrefix"  TEXT NOT NULL,
  "fee"             DECIMAL(10,2) NOT NULL,
  "minOrderValue"   DECIMAL(10,2),
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_zones_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "delivery_zones_locationId_postcodePrefix_key"
  ON "delivery_zones"("locationId", "postcodePrefix");
CREATE INDEX IF NOT EXISTS "delivery_zones_tenantId_idx" ON "delivery_zones"("tenantId");
CREATE INDEX IF NOT EXISTS "delivery_zones_locationId_idx" ON "delivery_zones"("locationId");

-- ── 3. location_payment_configs table
-- One row per location, holding the merchant's payment provider preference and
-- a non-secret config blob. Actual provider credentials live in the existing
-- integrations table (encrypted at rest) — this row only stores selection +
-- non-secret behaviour toggles.
CREATE TABLE IF NOT EXISTS "location_payment_configs" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "provider"         TEXT NOT NULL DEFAULT 'MANUAL',
  "cashEnabled"      BOOLEAN NOT NULL DEFAULT true,
  "cardTerminalEnabled" BOOLEAN NOT NULL DEFAULT true,
  "onlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT false,
  "config"           JSONB NOT NULL DEFAULT '{}',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "location_payment_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "location_payment_configs_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "location_payment_configs_locationId_key"
  ON "location_payment_configs"("locationId");
CREATE INDEX IF NOT EXISTS "location_payment_configs_tenantId_idx"
  ON "location_payment_configs"("tenantId");
