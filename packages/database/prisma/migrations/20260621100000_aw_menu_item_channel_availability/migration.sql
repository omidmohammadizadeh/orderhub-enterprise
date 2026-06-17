-- Phase AW-14 — per-channel item snooze ("86 board").
--
-- One row per (menu_item, channel) pair currently flipped off. The
-- row's existence + a future-or-null expires_at is what hides the
-- item from the storefront / POS / marketplace. Absence = available.
--
-- Idempotent: ADD COLUMN / CREATE TABLE IF NOT EXISTS so re-runs
-- after a partial deploy don't blow up.

CREATE TABLE IF NOT EXISTS "menu_item_channel_availability" (
  "id"            TEXT PRIMARY KEY,
  "itemId"        TEXT NOT NULL,
  "channel"       TEXT NOT NULL,
  "isAvailable"   BOOLEAN NOT NULL DEFAULT FALSE,
  "expiresAt"     TIMESTAMP(3),
  "snoozeReason"  TEXT,
  "snoozedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snoozedBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_channel_availability_itemId_channel_key"
  ON "menu_item_channel_availability" ("itemId", "channel");

CREATE INDEX IF NOT EXISTS "menu_item_channel_availability_itemId_idx"
  ON "menu_item_channel_availability" ("itemId");

CREATE INDEX IF NOT EXISTS "menu_item_channel_availability_channel_expiresAt_idx"
  ON "menu_item_channel_availability" ("channel", "expiresAt");

-- FK: drop-replace so a re-run lands cleanly.
ALTER TABLE "menu_item_channel_availability"
  DROP CONSTRAINT IF EXISTS "menu_item_channel_availability_itemId_fkey";

ALTER TABLE "menu_item_channel_availability"
  ADD CONSTRAINT "menu_item_channel_availability_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "menu_items"("id") ON DELETE CASCADE;
