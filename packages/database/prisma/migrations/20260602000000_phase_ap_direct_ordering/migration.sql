-- Phase AP — Direct online ordering settings + customer auth scaffold.
-- Per-location: prep times the storefront advertises and toggles for
-- which payment methods + order types it accepts.

CREATE TABLE IF NOT EXISTS "direct_ordering_configs" (
  "id"                       TEXT NOT NULL,
  "tenantId"                 TEXT NOT NULL,
  "locationId"               TEXT NOT NULL,
  "deliveryPrepMinutes"      INT  NOT NULL DEFAULT 45,
  "collectionPrepMinutes"    INT  NOT NULL DEFAULT 20,
  "acceptsCash"              BOOLEAN NOT NULL DEFAULT true,
  "acceptsCard"              BOOLEAN NOT NULL DEFAULT true,
  "acceptsDelivery"          BOOLEAN NOT NULL DEFAULT true,
  "acceptsCollection"        BOOLEAN NOT NULL DEFAULT true,
  "scheduleMaxDaysAhead"     INT  NOT NULL DEFAULT 7,
  "scheduleSlotMinutes"      INT  NOT NULL DEFAULT 15,
  "minOrderForDelivery"      DECIMAL(10,2),
  "heroImageUrl"             TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "direct_ordering_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "direct_ordering_configs_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "direct_ordering_configs_locationId_key"
  ON "direct_ordering_configs"("locationId");
CREATE INDEX IF NOT EXISTS "direct_ordering_configs_tenantId_idx"
  ON "direct_ordering_configs"("tenantId");

-- Phase AP — link customer email/phone to Supabase auth user when the
-- customer signs in. Nullable so existing rows (created from delivery
-- platforms) are untouched.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "supabaseUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "lastSignInAt"   TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "customers_supabaseUserId_key"
  ON "customers"("supabaseUserId")
  WHERE "supabaseUserId" IS NOT NULL;
