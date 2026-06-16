-- Phase AU follow-up — backfill OrderSource enum values.
--
-- HubRise-injected orders carry orderSource = UBER_EATS / DELIVEROO /
-- JUST_EAT (the platform that delivered the order TO HubRise). When
-- those values aren't present on the prod DB enum Prisma silently
-- skips the row on findMany — which is why HubRise orders appeared
-- on first arrival (the create itself succeeded thanks to text-mode
-- writes) but then "disappeared" after a refresh.
--
-- Each ADD VALUE has IF NOT EXISTS so re-running on an already-fixed
-- DB is a no-op.

ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'UBER_EATS';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'DELIVEROO';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'JUST_EAT';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'HUBRISE';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'TALABAT';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'DOORDASH';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'GRUBHUB';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'CAREEM';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'ONLINE';
