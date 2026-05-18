-- ─────────────────────────────────────────────────────────────────────────────
-- OrderHub Phase I Migration
-- Schema fields: isSandbox (Order), shopCode (Location), isActive (Printer)
-- Transactional outbox: OutboxEvent model + OutboxEventStatus enum
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Order: add isSandbox flag ────────────────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN "isSandbox" BOOLEAN NOT NULL DEFAULT false;

-- ── Location: add shopCode (unique, nullable) ────────────────────────────────
ALTER TABLE "locations" ADD COLUMN "shopCode" TEXT;
CREATE UNIQUE INDEX "locations_shopCode_key" ON "locations"("shopCode");

-- ── Printer: add isActive flag ───────────────────────────────────────────────
ALTER TABLE "printers" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- ── OutboxEvent enum + table ─────────────────────────────────────────────────
CREATE TYPE "OutboxEventStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'DEAD'
);

CREATE TABLE "outbox_events" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "locationId"     TEXT NOT NULL,
    "aggregateType"  TEXT NOT NULL,
    "aggregateId"    TEXT NOT NULL,
    "eventType"      TEXT NOT NULL,
    "payload"        JSONB NOT NULL,
    "status"         "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts"       INTEGER NOT NULL DEFAULT 0,
    "maxAttempts"    INTEGER NOT NULL DEFAULT 10,
    "nextAttemptAt"  TIMESTAMP(3),
    "processedAt"    TIMESTAMP(3),
    "lastError"      TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_events_idempotencyKey_key"
    ON "outbox_events"("idempotencyKey");

CREATE INDEX "outbox_events_status_nextAttemptAt_idx"
    ON "outbox_events"("status", "nextAttemptAt");

CREATE INDEX "outbox_events_tenantId_createdAt_idx"
    ON "outbox_events"("tenantId", "createdAt" DESC);

CREATE INDEX "outbox_events_aggregateType_aggregateId_idx"
    ON "outbox_events"("aggregateType", "aggregateId");
