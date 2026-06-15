-- Backfill OrderPlatform enum values that were declared in
-- schema.prisma (HUBRISE, POS, ONLINE) but never landed in a migration
-- file. Without these, OrdersService.create() crashes with 22P02
-- whenever the POS UI submits an order (it tags platform=POS).
--
-- IF NOT EXISTS so this can run on any environment, even ones where
-- the values were patched in manually.
--
-- Note: Postgres requires `ALTER TYPE ... ADD VALUE` to be committed
-- before the new value can be referenced. This migration ONLY does the
-- ADD VALUE — no inserts, no indexes that use the new values — so the
-- single-transaction wrapping Prisma applies is fine.

ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'HUBRISE';
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'POS';
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'ONLINE';
