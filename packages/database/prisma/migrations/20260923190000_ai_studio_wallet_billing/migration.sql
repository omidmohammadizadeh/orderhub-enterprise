-- AI Studio bills the location's wallet instead of its own credit pot, so a
-- render is priced in real money and one location can never spend another's
-- balance. Both columns are additive and nullable: rows written before this
-- keep their credit price in creditsCost and simply have no chargedMinor.
--
-- A NEW migration, deliberately — editing a shipped one changes its checksum
-- and the API refuses to boot. IF NOT EXISTS keeps it safe to re-run.
ALTER TABLE "video_generations" ADD COLUMN IF NOT EXISTS "chargedMinor" INTEGER;

-- Per-location price overrides, keyed by style id. Missing → platform default.
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "aiStudioPricesMinor" JSONB;
