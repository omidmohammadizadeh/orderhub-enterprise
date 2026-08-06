-- Who the agreement is FROM, for the signature certificate.
--
-- Nullable and with no default: null means "use the platform's own details",
-- which is what every existing row should keep doing. Backfilling a copy of
-- the current company details onto historic rows would freeze today's address
-- onto contracts signed before it, which is worse than resolving at render.
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "issuer" JSONB;
