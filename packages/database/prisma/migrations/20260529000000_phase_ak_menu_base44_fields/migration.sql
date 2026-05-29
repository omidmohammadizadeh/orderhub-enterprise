-- ── Phase AK — Menu Manager + POS foundation (Base44 audit fields) ──────────
-- Adds every column the Base44 menu/POS audit calls out as load-bearing:
--   * PLU on items / groups / options
--   * Multi-SKU pricing via hasMultipleSkus + productSkus JSON
--   * Per-size modifier pricing via pricesBySize / skuPlus JSON
--   * Many-to-many menu membership via menuIds Postgres arrays
--   * Import / sync lifecycle (lock, status, hash, raw payloads)
--   * Per-channel tax (delivery/takeaway/eat-in) — % points
--   * Visibility split: isAvailable vs visibleToCustomers vs outOfStock
--
-- Idempotent: every statement uses IF NOT EXISTS / DO-block guards so a
-- partially-applied retry recovers cleanly.

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MenuType') THEN
    CREATE TYPE "MenuType" AS ENUM ('DELIVERY', 'DELIVERY_AND_PICKUP');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SelectionType') THEN
    CREATE TYPE "SelectionType" AS ENUM ('VARIANT', 'ADDON');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MenuImportStatus') THEN
    CREATE TYPE "MenuImportStatus" AS ENUM ('IDLE', 'IMPORTING', 'SUCCESS', 'FAILED');
  END IF;
END $$;

-- ── menus ────────────────────────────────────────────────────────────────────
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "locationId"   TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "menuType"     "MenuType" NOT NULL DEFAULT 'DELIVERY_AND_PICKUP';
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "bannerImage"  TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "heroImage"    TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "logoImage"    TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "importStatus" "MenuImportStatus" NOT NULL DEFAULT 'IDLE';
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "importLock"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "importedAt"   TIMESTAMP(3);
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "syncVersion"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "rawImportPayload"           JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "menuData"                   JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "productModifierGroupLinks"  JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "modifierGroupModifierLinks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "platformSource"   TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "externalId"       TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "externalParentId" TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "lastSyncedAt"     TIMESTAMP(3);
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "syncStatus"       TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "syncHash"         TEXT;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "publishedTo"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "lastPublishedAt"  TIMESTAMP(3);
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "autoScheduleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "autoSchedule"     JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "menus_locationId_idx"             ON "menus"("locationId");
CREATE INDEX IF NOT EXISTS "menus_locationId_isActive_idx"    ON "menus"("locationId", "isActive");
CREATE INDEX IF NOT EXISTS "menus_platformSource_externalId_idx" ON "menus"("platformSource", "externalId");

-- ── menu_categories ──────────────────────────────────────────────────────────
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "menuIds"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "available"          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "visibleToCustomers" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "platformSource"     TEXT;
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "externalId"         TEXT;
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "externalParentId"   TEXT;
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "lastSyncedAt"       TIMESTAMP(3);
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "syncStatus"         TEXT;
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "syncHash"           TEXT;

CREATE INDEX IF NOT EXISTS "menu_categories_platformSource_externalId_idx" ON "menu_categories"("platformSource", "externalId");

-- ── menu_items ───────────────────────────────────────────────────────────────
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "plu" TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "visibleToCustomers" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "outOfStock"         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "availableRestoreAt" TIMESTAMP(3);
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "dietary"            JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "hasMultipleSkus"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "productSkus"        JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "deliveryTax"        DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "takeawayTax"        DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "eatInTax"           DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "menuIds"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "brandIds"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "sortOrder"          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "platformSource"     TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "externalId"         TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "externalParentId"   TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "lastSyncedAt"       TIMESTAMP(3);
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "syncStatus"         TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "syncHash"           TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "rawModifierGroupIds" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS "menu_items_plu_idx"                         ON "menu_items"("plu");
CREATE INDEX IF NOT EXISTS "menu_items_platformSource_externalId_idx"   ON "menu_items"("platformSource", "externalId");

-- ── modifier_groups ──────────────────────────────────────────────────────────
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "plu"                       TEXT;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "selectionType"             "SelectionType" NOT NULL DEFAULT 'VARIANT';
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "allowDuplicateSelections"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "visibleToCustomers"        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "menuIds"                   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "platformSource"            TEXT;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "externalId"                TEXT;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "externalParentId"          TEXT;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "lastSyncedAt"              TIMESTAMP(3);
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "syncStatus"                TEXT;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "syncHash"                  TEXT;
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "rawModifierIds"            JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "modifier_groups" ADD COLUMN IF NOT EXISTS "metadata"                  JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "modifier_groups_plu_idx"                       ON "modifier_groups"("plu");
CREATE INDEX IF NOT EXISTS "modifier_groups_platformSource_externalId_idx" ON "modifier_groups"("platformSource", "externalId");

-- ── modifier_options ─────────────────────────────────────────────────────────
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "modifierGroupIds"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "plu"                TEXT;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "pricesBySize"       JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "skuPlus"            JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "visibleToCustomers" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "availableRestoreAt" TIMESTAMP(3);
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "menuIds"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "deliveryTax"        DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "takeawayTax"        DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "eatInTax"           DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "platformSource"     TEXT;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "externalId"         TEXT;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "externalParentId"   TEXT;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "lastSyncedAt"       TIMESTAMP(3);
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "syncStatus"         TEXT;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "syncHash"           TEXT;
ALTER TABLE "modifier_options" ADD COLUMN IF NOT EXISTS "metadata"           JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "modifier_options_plu_idx"                       ON "modifier_options"("plu");
CREATE INDEX IF NOT EXISTS "modifier_options_platformSource_externalId_idx" ON "modifier_options"("platformSource", "externalId");
