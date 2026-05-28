-- ── Phase AJ — Order Foundation ──────────────────────────────────────────────
-- Adds Base44-parity status values and the small handful of Order columns
-- that the operational UI and printer payload actually need to query/filter
-- on. Everything else (courier_*, food_photo_url, stripe_*, hubrise_*, etc.)
-- continues to live in `orders.metadata` JSONB until it needs to be indexable.
--
-- All statements use IF NOT EXISTS so the migration is idempotent and safe
-- to re-run if a deploy was interrupted partway through.
--
-- Note: ALTER TYPE ADD VALUE values cannot be USED in the same transaction
-- they're added in. We only ADD them here; the API code that emits the new
-- values doesn't run until after the migration commits, so this is safe.

-- ── 1. Extend OrderStatus enum with Base44-granular values ───────────────────
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED_DRIVER';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED_BY_DRIVER';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'OUT_FOR_DELIVERY';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- ── 2. Add Order columns ─────────────────────────────────────────────────────
-- Optional brand reference (a location can serve multiple virtual brands).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "brandId" TEXT;

-- Customer-facing collection / pickup code displayed on the order card.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "collectionCode" TEXT;

-- Per-order override of the default prep time (minutes).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "preparationMinutes" INTEGER;

-- Reason captured when an order transitions to FAILED (distinct from cancelReason).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;

-- ── 3. Foreign key for brandId (NOT VALID skips scanning existing rows) ──────
-- All existing rows have brandId = NULL so the FK is trivially satisfied; we
-- skip the scan to make the migration fast on large tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'orders' AND constraint_name = 'orders_brandId_fkey'
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id")
      ON DELETE SET NULL ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;

-- ── 4. Indexes for brand-scoped order queries ────────────────────────────────
CREATE INDEX IF NOT EXISTS "orders_brandId_idx"            ON "orders"("brandId");
CREATE INDEX IF NOT EXISTS "orders_tenantId_brandId_idx"   ON "orders"("tenantId", "brandId");
CREATE INDEX IF NOT EXISTS "orders_brandId_status_idx"     ON "orders"("brandId", "status");
