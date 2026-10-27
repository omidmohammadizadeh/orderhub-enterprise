-- Push notifications: native app tokens beside browser subscriptions, a
-- separate yes for offers, per-stage wording, review asks and campaigns.

ALTER TABLE "customer_push_subscriptions"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'WEB',
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "appId" TEXT,
  ADD COLUMN "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "p256dh" DROP NOT NULL,
  ALTER COLUMN "auth" DROP NOT NULL;

CREATE TABLE "push_automations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "title" TEXT,
  "body" TEXT,
  "delayMinutes" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "push_automations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_automations_tenantId_trigger_key" ON "push_automations"("tenantId", "trigger");

CREATE TABLE "push_review_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "claimedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "push_review_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_review_requests_orderId_key" ON "push_review_requests"("orderId");
CREATE INDEX "push_review_requests_status_dueAt_idx" ON "push_review_requests"("status", "dueAt");

CREATE TABLE "push_campaigns" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "locationId" TEXT,
  "brandId" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "scheduledFor" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "targeted" INTEGER NOT NULL DEFAULT 0,
  "delivered" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "push_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "push_campaigns_tenantId_createdAt_idx" ON "push_campaigns"("tenantId", "createdAt");
CREATE INDEX "push_campaigns_status_scheduledFor_idx" ON "push_campaigns"("status", "scheduledFor");
