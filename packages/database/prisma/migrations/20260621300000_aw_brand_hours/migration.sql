-- Phase AW-16 — brand-level opening hours + prep time.
--
-- Operators set hours / prep on the BRAND, not the location, so a
-- single kitchen running three virtual brands has three independent
-- schedules. The Publish Hours button (AW-16-D) writes through to
-- HubRise via PATCH /v1/locations/:id { opening_hours,
-- preparation_time }.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Existing brand rows get
-- the empty default; the operator fills them in via the brand
-- settings drawer.

ALTER TABLE "brands"
  ADD COLUMN IF NOT EXISTS "openingHours" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "prepTime"          INTEGER,
  ADD COLUMN IF NOT EXISTS "busyExtraPrepTime" INTEGER;
