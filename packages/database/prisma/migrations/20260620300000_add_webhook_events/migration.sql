-- Phase AU — backfill: create webhook_events.
--
-- The Prisma model WebhookEvent has existed in schema.prisma since
-- the original webhook ingestion work, but no migration ever created
-- the table in production. The HubRise global webhook handler hit
-- this immediately: every inbound event landed at
-- `WebhookIngestionService.ingest()`, which calls
-- `prisma.webhookEvent.create(...)` for idempotency tracking, and
-- crashed with "The table public.webhook_events does not exist". The
-- request bubbled up as 500 to HubRise, which kept retrying.
--
-- Idempotent so re-running on a partially-applied DB is safe.

CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"              TEXT         NOT NULL,
  "platform"        TEXT         NOT NULL,
  "externalEventId" TEXT         NOT NULL,
  "tenantId"        TEXT,
  "locationId"      TEXT,
  "signature"       TEXT,
  "rawPayload"      JSONB        NOT NULL,
  "processedAt"     TIMESTAMP(3),
  "processingError" TEXT,
  "retryCount"      INTEGER      NOT NULL DEFAULT 0,
  "orderId"         TEXT,
  "metadata"        JSONB        NOT NULL DEFAULT '{}',
  "receivedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- Idempotency guard: HubRise / Uber / Deliveroo retry the same event
-- many times on transient failures. This unique index is what makes
-- the `catch P2002` in WebhookIngestionService work — once we've seen
-- (platform, externalEventId) we short-circuit instead of double-
-- creating the Order.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_platform_externalEventId_key"
  ON "webhook_events"("platform", "externalEventId");

-- Per-platform recency lookup for the Logs UI / debugging.
CREATE INDEX IF NOT EXISTS "webhook_events_platform_receivedAt_idx"
  ON "webhook_events"("platform", "receivedAt" DESC);

-- Per-tenant recency lookup for ops dashboards.
CREATE INDEX IF NOT EXISTS "webhook_events_tenantId_receivedAt_idx"
  ON "webhook_events"("tenantId", "receivedAt" DESC);

-- Lets us walk forward from an Order to the webhook that created it
-- (used by the order audit drawer).
CREATE INDEX IF NOT EXISTS "webhook_events_orderId_idx"
  ON "webhook_events"("orderId");
