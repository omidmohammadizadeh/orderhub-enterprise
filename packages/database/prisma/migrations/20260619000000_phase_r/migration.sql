-- Phase R: Billing & Subscriptions
-- Adds FREE_PILOT/UNPAID statuses, grace period + billing fields to TenantSubscription,
-- and new UsageRecord / StripeWebhookEvent tables for usage tracking and idempotency.

-- 1. Extend SubscriptionStatus enum
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'FREE_PILOT';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'UNPAID';

-- 2. Add billing fields to tenant_subscriptions
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "billingEmail"        TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMethodStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "lastInvoiceStatus"   TEXT,
  ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt"   TIMESTAMP(3);

-- Index on status for billing status queries
CREATE INDEX IF NOT EXISTS "tenant_subscriptions_status_idx"
  ON "tenant_subscriptions"("status");

-- 3. Usage records table
CREATE TABLE IF NOT EXISTS "usage_records" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "subscriptionId"  TEXT NOT NULL,
  "locationId"      TEXT NOT NULL,
  "billingMonth"    DATE NOT NULL,
  "orderCount"      INTEGER NOT NULL DEFAULT 0,
  "printJobCount"   INTEGER NOT NULL DEFAULT 0,
  "activeProviders" INTEGER NOT NULL DEFAULT 0,
  "reportedToStripe" BOOLEAN NOT NULL DEFAULT false,
  "reportedAt"      TIMESTAMP(3),
  "metadata"        JSONB NOT NULL DEFAULT '{}',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_records_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "tenant_subscriptions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_tenantId_locationId_billingMonth_key"
  ON "usage_records"("tenantId", "locationId", "billingMonth");

CREATE INDEX IF NOT EXISTS "usage_records_tenantId_billingMonth_idx"
  ON "usage_records"("tenantId", "billingMonth" DESC);

CREATE INDEX IF NOT EXISTS "usage_records_subscriptionId_idx"
  ON "usage_records"("subscriptionId");

-- 4. Stripe webhook event idempotency log
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id"            TEXT NOT NULL,
  "stripeEventId" TEXT NOT NULL,
  "type"          TEXT NOT NULL,
  "processedAt"   TIMESTAMP(3),
  "error"         TEXT,
  "payload"       JSONB NOT NULL,
  "receivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stripe_webhook_events_stripeEventId_key"
  ON "stripe_webhook_events"("stripeEventId");

CREATE INDEX IF NOT EXISTS "stripe_webhook_events_type_receivedAt_idx"
  ON "stripe_webhook_events"("type", "receivedAt" DESC);
