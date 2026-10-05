-- Email automations (welcome / win-back) + the link from their ledger campaigns.
-- Purely additive.

-- AlterTable
ALTER TABLE "email_campaigns" ADD COLUMN     "automationId" TEXT;

-- CreateTable
CREATE TABLE "email_automations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "brandId" TEXT,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "subject" TEXT NOT NULL DEFAULT '',
    "preheader" TEXT,
    "fromName" TEXT,
    "replyTo" TEXT,
    "design" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_automations_enabled_idx" ON "email_automations"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "email_automations_tenantId_locationId_type_key" ON "email_automations"("tenantId", "locationId", "type");

-- CreateIndex
CREATE INDEX "email_campaigns_automationId_idx" ON "email_campaigns"("automationId");

