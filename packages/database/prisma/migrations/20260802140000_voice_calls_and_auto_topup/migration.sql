-- AI voice receptionist: per-call billing off the existing wallet, plus the
-- auto top-up that stops an empty wallet silently taking the phone offline.
-- Additive and idempotent — safe to re-run on boot.

-- ── Wallet: voice rate + auto top-up ──────────────────────────────────────
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "voicePricePerCallMinor"  INTEGER;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoTopupEnabled"        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoTopupThresholdMinor" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoTopupAmountMinor"    INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "stripePaymentMethodId"   TEXT;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoTopupLastAt"         TIMESTAMP(3);
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoTopupFailedAt"       TIMESTAMP(3);
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoTopupFailureReason"  TEXT;

-- ── Wallet ledger: one charge per call, enforced by the database ──────────
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "voiceCallId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_voiceCallId_key"
  ON "wallet_transactions"("voiceCallId");

-- ── Calls ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "voice_calls" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "locationId"        TEXT NOT NULL,
  "brandId"           TEXT,
  "providerCallId"    TEXT,
  "provider"          TEXT NOT NULL DEFAULT 'TELNYX',
  "fromNumber"        TEXT,
  "toNumber"          TEXT,
  "direction"         TEXT NOT NULL DEFAULT 'INBOUND',
  "status"            TEXT NOT NULL DEFAULT 'RINGING',
  "notAnsweredReason" TEXT,
  "answeredAt"        TIMESTAMP(3),
  "endedAt"           TIMESTAMP(3),
  "durationSeconds"   INTEGER,
  "outcome"           TEXT,
  "orderId"           TEXT,
  "reservationId"     TEXT,
  "wasOverflow"       BOOLEAN NOT NULL DEFAULT false,
  "billedMinor"       INTEGER,
  "billedAt"          TIMESTAMP(3),
  "transcript"        JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "voice_calls_providerCallId_key"   ON "voice_calls"("providerCallId");
CREATE INDEX IF NOT EXISTS "voice_calls_tenantId_createdAt_idx"      ON "voice_calls"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "voice_calls_locationId_createdAt_idx"    ON "voice_calls"("locationId", "createdAt");
CREATE INDEX IF NOT EXISTS "voice_calls_locationId_status_idx"       ON "voice_calls"("locationId", "status");
