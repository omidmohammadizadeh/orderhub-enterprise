-- Phase AS-2 — print lifecycle integration: retry / dead-letter on
-- PrintJob, agent telemetry fields, printer capability columns.

-- ── PrintJob: retry + dead-letter ──────────────────────────────────
ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "nextRetryAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failureReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "deadLetteredAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastError"       TEXT;

CREATE INDEX IF NOT EXISTS "print_jobs_nextRetryAt_idx"
  ON "print_jobs"("nextRetryAt")
  WHERE "nextRetryAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "print_jobs_deadLetteredAt_idx"
  ON "print_jobs"("deadLetteredAt")
  WHERE "deadLetteredAt" IS NOT NULL;

-- ── PrintAgent: telemetry ──────────────────────────────────────────
ALTER TABLE "print_agents"
  ADD COLUMN IF NOT EXISTS "osType"        TEXT,
  ADD COLUMN IF NOT EXISTS "hostname"      TEXT,
  ADD COLUMN IF NOT EXISTS "printerCount"  INTEGER NOT NULL DEFAULT 0;

-- ── Printer: explicit capability columns ───────────────────────────
-- Existing supportsReceipts/Kitchen/Labels/Cut/CashDrawer stay; we add
-- the missing capabilities the spec calls out so the Flutter client
-- can render the right transport options without parsing JSON.
ALTER TABLE "printers"
  ADD COLUMN IF NOT EXISTS "supportsBluetooth" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "supportsUsb"       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "supportsLan"       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "supportsEscPos"    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "supportsQrCode"    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "supportsImages"    BOOLEAN NOT NULL DEFAULT FALSE;
