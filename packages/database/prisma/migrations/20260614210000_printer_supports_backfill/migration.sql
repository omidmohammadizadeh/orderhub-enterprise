-- Backfill missing `supports*` boolean columns on printers.
--
-- These five flags have been declared on the Printer model in
-- schema.prisma since the original AS-1 work but no migration ever
-- added them. AS-2 only introduced the newer BT/USB/LAN/ESC/QR/Images
-- columns. Production therefore 500s on every Printer query and the
-- ServerDirectPrintCron logs:
--   "The column `printers.supportsCashDrawer` does not exist"
--   "The column `printers.supportsReceipts` does not exist"
--
-- IF NOT EXISTS keeps this safe on any DB where they happen to already
-- exist (local dev that ran prisma db push, etc).

ALTER TABLE "printers"
  ADD COLUMN IF NOT EXISTS "supportsReceipts"   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "supportsKitchen"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "supportsLabels"     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "supportsCut"        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "supportsCashDrawer" BOOLEAN NOT NULL DEFAULT FALSE;
