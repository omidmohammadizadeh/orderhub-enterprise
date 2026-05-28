-- ── Phase AJ — Reconcile orders schema with current Prisma model ────────────
-- Earlier supplemental migrations (phase_e_supplement, phase_f) were
-- repeatedly marked rolled-back by scripts/start-api.sh, but contain non-
-- idempotent statements (`CREATE TYPE`, `ALTER TABLE ADD COLUMN` without
-- IF NOT EXISTS). When Prisma re-runs them the first failing statement
-- aborts the transaction and rolls back the rest, leaving the schema in
-- an arbitrary partial state — exactly what's surfacing as:
--
--   Invalid `prisma.order.create()` invocation:
--   The column `orders.tenantId` does not exist in the current database.
--
-- This migration fully reconciles the `orders` table (and its enum
-- dependencies) with what the current schema.prisma declares. Every
-- statement is idempotent so the migration is safe to re-run if a deploy
-- is interrupted, AND it cannot be left half-applied by the rollback
-- trick used in the startup script.

-- ── Enum types (DO block lets us CREATE TYPE conditionally) ──────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderSource') THEN
    CREATE TYPE "OrderSource" AS ENUM (
      'ONLINE', 'POS', 'UBER_EATS', 'DELIVEROO', 'JUST_EAT',
      'HUBRISE', 'DIRECT', 'TALABAT', 'DOORDASH', 'GRUBHUB', 'CAREEM'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntegrationSource') THEN
    CREATE TYPE "IntegrationSource" AS ENUM ('DIRECT', 'HUBRISE');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FulfillmentType') THEN
    CREATE TYPE "FulfillmentType" AS ENUM (
      'PICKUP', 'DELIVERY', 'DINE_IN', 'MERCHANT_DELIVERY', 'PLATFORM_COURIER'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderStatusActorType') THEN
    CREATE TYPE "OrderStatusActorType" AS ENUM (
      'STAFF', 'SYSTEM', 'WEBHOOK', 'API', 'KIOSK'
    );
  END IF;
END $$;

-- ── orders columns ───────────────────────────────────────────────────────────
-- The schema-vs-DB delta. Anything created by the init migration is a
-- no-op; everything from phase_e / phase_e_supplement / phase_i / phase_aj
-- onwards is added defensively here.

-- Tenant scope (the immediate blocker that surfaced this whole bug).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Customer + brand references.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "brandId" TEXT;

-- Source / integration tracking.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "orderSource"       "OrderSource"       NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "integrationSource" "IntegrationSource" NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "viaHubrise"        BOOLEAN             NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillmentType"   "FulfillmentType"   NOT NULL DEFAULT 'DELIVERY';

-- Customer fields hoisted from JSONB for filtering/searching.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerName"  TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerPhone" TEXT;

-- Sandbox flag (Phase I).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "isSandbox" BOOLEAN NOT NULL DEFAULT false;

-- Financial extras.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "serviceCharge" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promoCode"     TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promoDiscount" DECIMAL(10,2);

-- Idempotency + extra timestamps.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "idempotencyKey"   TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receivedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "preparingAt"      TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "outForDeliveryAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveredAt"      TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "acceptedAt"       TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "readyAt"          TIMESTAMP(3);

-- Source metadata (raw platform payload).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sourceMetadata" JSONB NOT NULL DEFAULT '{}';

-- Phase AJ fields (already added by 20260520200000_phase_aj_order_foundation;
-- repeated here so a clean reset only needs this one migration).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "collectionCode"     TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "preparationMinutes" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "failureReason"      TEXT;

-- ── Unique constraints + indexes (all IF NOT EXISTS) ─────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "orders_idempotencyKey_key" ON "orders"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "orders_tenantId_createdAt_idx"        ON "orders"("tenantId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "orders_tenantId_status_idx"           ON "orders"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "orders_tenantId_locationId_idx"       ON "orders"("tenantId", "locationId");
CREATE INDEX IF NOT EXISTS "orders_tenantId_orderSource_idx"      ON "orders"("tenantId", "orderSource");
CREATE INDEX IF NOT EXISTS "orders_locationId_orderSource_idx"   ON "orders"("locationId", "orderSource");
CREATE INDEX IF NOT EXISTS "orders_orderSource_idx"               ON "orders"("orderSource");
CREATE INDEX IF NOT EXISTS "orders_integrationSource_idx"         ON "orders"("integrationSource");
CREATE INDEX IF NOT EXISTS "orders_tenantId_customerPhone_idx"   ON "orders"("tenantId", "customerPhone");
CREATE INDEX IF NOT EXISTS "orders_tenantId_customerName_idx"    ON "orders"("tenantId", "customerName");
CREATE INDEX IF NOT EXISTS "orders_customerId_idx"                ON "orders"("customerId");

-- ── @@unique([externalId, platform]) ─────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'orders_externalId_platform_key'
  ) THEN
    CREATE UNIQUE INDEX "orders_externalId_platform_key"
      ON "orders"("externalId", "platform");
  END IF;
END $$;

-- ── Foreign keys (NOT VALID = no scan of existing rows) ──────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'orders' AND constraint_name = 'orders_customerId_fkey'
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "customers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'orders' AND constraint_name = 'orders_tenantId_fkey'
  ) THEN
    -- Tenant FK is RESTRICTed in schema.prisma — but adding RESTRICT here
    -- could choke on rare data states. Use NO ACTION + NOT VALID and let
    -- Prisma generate the production-strict version on the next baseline.
    ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
      ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

-- ── order_status_history.actorType ───────────────────────────────────────────
ALTER TABLE "order_status_history" ADD COLUMN IF NOT EXISTS "actorType" "OrderStatusActorType" NOT NULL DEFAULT 'SYSTEM';
