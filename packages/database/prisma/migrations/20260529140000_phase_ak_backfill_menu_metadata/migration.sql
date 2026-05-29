-- ── Phase AK reconcile — backfill missing metadata columns on menu tables ────
-- The Phase AK schema added `metadata Json @default("{}")` to Menu,
-- MenuItem, ModifierGroup, and ModifierOption — but the original AK
-- migration only ALTERed modifier_groups and modifier_options. The new
-- columns on menus + menu_items were silently absent in production,
-- which surfaced as:
--
--   Invalid `prisma.menu.findMany()` invocation:
--   The column `menus.metadata` does not exist in the current database.
--
-- The Prisma client SELECTs every declared column, so any read on the
-- Menu Manager UI 500'd before the operator could even create a menu.
--
-- Fix: idempotent ADD COLUMN IF NOT EXISTS for every table that needs
-- it. menu_categories also gets `metadata` so a future row-level
-- annotation field (e.g. seasonal flags from imports) won't need
-- another migration when we use it.

ALTER TABLE "menus"            ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "menu_items"       ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "menu_categories"  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';
