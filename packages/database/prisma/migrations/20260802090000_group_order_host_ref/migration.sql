-- The host's browser-scoped ref. Closing, placing and cancelling a shared
-- basket are host-only, and with no login this is the only credential there
-- is. Nullable so baskets created before this column keep working (they fall
-- back to link-holder trust). Additive and idempotent — safe to re-run on boot.

ALTER TABLE "group_orders" ADD COLUMN IF NOT EXISTS "hostRef" TEXT;
