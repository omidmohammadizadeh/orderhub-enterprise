-- Phase BF correction #2 — the previous design auto-derived the variant
-- ref from (brandId, channel), so the operator only picked a source menu.
-- That's wrong: the operator must explicitly pick BOTH a menu AND a named
-- variant on it (e.g. "monster burgerz — Deliveroo"), because that variant
-- also determines which BRAND'S ITEMS the channel is restricted to, not
-- just which prices apply. Any row from the brief window the previous
-- design was live has no real variant selection behind it, so it's safe
-- to clear rather than backfill.
DELETE FROM "brand_channel_sources";

ALTER TABLE "brand_channel_sources"
  ADD COLUMN "variantRef" TEXT NOT NULL;
