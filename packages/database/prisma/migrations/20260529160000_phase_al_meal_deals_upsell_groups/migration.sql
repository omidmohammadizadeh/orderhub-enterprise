-- ── Phase AL — Meal Deals + Upsell Groups ──────────────────────────────────
-- Master-catalog models that the new /dashboard/products section creates
-- and edits. Menus link to these — they don't duplicate them.

CREATE TABLE IF NOT EXISTS "meal_deals" (
  "id"          TEXT NOT NULL,
  "brandId"     TEXT NOT NULL,
  "locationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "imageUrl"    TEXT,
  "plu"         TEXT,
  "price"       DECIMAL(10,2),
  "sections"    JSONB NOT NULL DEFAULT '[]',
  "deliveryTax" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "takeawayTax" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "eatInTax"    DECIMAL(5,2) NOT NULL DEFAULT 0,
  "platformPricingOverrides" JSONB NOT NULL DEFAULT '{}',
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "visibleToCustomers" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "platformSource"   TEXT,
  "externalId"       TEXT,
  "lastSyncedAt"     TIMESTAMP(3),
  "syncStatus"       TEXT,
  "syncHash"         TEXT,
  "metadata"    JSONB NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "meal_deals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "meal_deals_brandId_idx" ON "meal_deals"("brandId");
CREATE INDEX IF NOT EXISTS "meal_deals_brandId_isAvailable_idx" ON "meal_deals"("brandId","isAvailable");
CREATE INDEX IF NOT EXISTS "meal_deals_plu_idx" ON "meal_deals"("plu");

-- FK to brands. NOT VALID skips a scan against pre-existing rows (table is
-- empty on creation, so this is a no-op, but it matches the rest of our
-- defensive migration style).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'meal_deals' AND constraint_name = 'meal_deals_brandId_fkey'
  ) THEN
    ALTER TABLE "meal_deals" ADD CONSTRAINT "meal_deals_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "upsell_groups" (
  "id"   TEXT NOT NULL,
  "brandId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "triggerProductIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "triggerCategoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "suggestedProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "platformVisibility" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "upsell_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "upsell_groups_brandId_idx" ON "upsell_groups"("brandId");
CREATE INDEX IF NOT EXISTS "upsell_groups_brandId_isActive_idx" ON "upsell_groups"("brandId","isActive");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'upsell_groups' AND constraint_name = 'upsell_groups_brandId_fkey'
  ) THEN
    ALTER TABLE "upsell_groups" ADD CONSTRAINT "upsell_groups_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
