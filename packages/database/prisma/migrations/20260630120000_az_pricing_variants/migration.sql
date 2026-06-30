-- Phase AZ — pricing variants (one menu, per-channel/per-variant pricing).
-- Menu gains a list of named variants; modifier options gain per-variant
-- price overrides (items already have platformPricingOverrides; SKU-level
-- overrides ride inside the existing productSkus JSON). Idempotent.

ALTER TABLE "menus"
  ADD COLUMN IF NOT EXISTS "pricingVariants" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "modifier_options"
  ADD COLUMN IF NOT EXISTS "platformPricingOverrides" JSONB NOT NULL DEFAULT '{}';
