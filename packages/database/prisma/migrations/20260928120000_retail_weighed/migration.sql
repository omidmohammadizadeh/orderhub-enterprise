-- Retail: products sold by weight. Additive only.
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "sellBy" TEXT;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "scaleCode" TEXT;
