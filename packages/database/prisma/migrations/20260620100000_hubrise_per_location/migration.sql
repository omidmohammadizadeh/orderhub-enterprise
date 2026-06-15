-- Phase AU — HubRise integration is per-location, not per-brand.
--
-- Operators paste an access token + catalog id they generated against
-- HubRise outside our app. We store the token via the Secrets Vault
-- (only the secret id lives on this row) and keep the catalog id in
-- plaintext for fast filtering.
--
-- Idempotent: existing deploys won't be broken by re-running.

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "hubriseCredentials" JSONB,
  ADD COLUMN IF NOT EXISTS "hubriseCatalogId"   TEXT,
  ADD COLUMN IF NOT EXISTS "hubriseLocationId"  TEXT,
  ADD COLUMN IF NOT EXISTS "hubriseConnectedAt" TIMESTAMP(3);
