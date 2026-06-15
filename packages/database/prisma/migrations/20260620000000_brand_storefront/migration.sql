-- Phase AS-6 — brand-level public storefront.
--
-- Mirrors the per-location storefront pattern on Brand so virtual
-- brands running out of a shared kitchen can expose their own
-- customer-facing URL (/brand/<slug>) separate from the location page.
--
-- Idempotent: every statement guards on existence so this can be
-- re-run safely against a partially-migrated DB without aborting.

ALTER TABLE "brands"
  ADD COLUMN IF NOT EXISTS "onlineOrderingSlug"     TEXT,
  ADD COLUMN IF NOT EXISTS "directOrderingEnabled"  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "about"                  TEXT;

-- Unique constraint on slug so two brands can't share the same URL.
-- Postgres lets multiple NULLs coexist under a UNIQUE index, so this
-- only fires when the operator actually assigns a slug.
CREATE UNIQUE INDEX IF NOT EXISTS "brands_onlineOrderingSlug_key"
  ON "brands"("onlineOrderingSlug");
