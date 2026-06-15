-- Phase AU — backfill: add hubriseLocationId to existing locations.
--
-- The 20260620100000_hubrise_per_location migration originally only
-- added hubriseCredentials / hubriseCatalogId / hubriseConnectedAt.
-- Editing that file's SQL after it had already been applied in
-- production doesn't replay — `prisma migrate deploy` tracks
-- migrations by name, not checksum. The Prisma client still got
-- regenerated to include hubriseLocationId, so any SELECT on locations
-- started failing with "column does not exist", which presented as
-- the entire Locations dashboard going empty.
--
-- Fix: ship the column add as a fresh migration. Idempotent, so re-
-- running is safe.

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "hubriseLocationId" TEXT;
