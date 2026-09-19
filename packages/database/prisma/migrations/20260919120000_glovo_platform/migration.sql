-- Phase GL — direct Glovo integration.
--
-- Glovo orders are written with platform/source "GLOVO" and the platform is
-- listed as an IntegrationPlatform. A NEW migration, deliberately: editing an
-- already-shipped one changes its checksum and the API refuses to boot.
--
-- ADD VALUE is not reversible in Postgres and the new value cannot be used in
-- the same transaction that adds it, so this migration only widens the types.
-- IF NOT EXISTS keeps it safe to re-run where the value was added by hand.
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'GLOVO';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'GLOVO';
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'GLOVO';
