-- Marketing SMS: consented audience + broadcast campaigns.

ALTER TABLE "sms_messages" ADD COLUMN "campaignId" TEXT;

CREATE TABLE "marketing_contacts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "source" TEXT,
    "customerId" TEXT,
    "consentStatus" TEXT NOT NULL DEFAULT 'OPTED_IN',
    "consentSource" TEXT,
    "consentAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "tags" TEXT[],
    "lastCampaignAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_contacts_tenantId_phone_key" ON "marketing_contacts"("tenantId", "phone");
CREATE INDEX "marketing_contacts_tenantId_consentStatus_idx" ON "marketing_contacts"("tenantId", "consentStatus");
CREATE INDEX "marketing_contacts_tenantId_source_idx" ON "marketing_contacts"("tenantId", "source");

CREATE TABLE "marketing_sms_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "senderHeader" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "audience" JSONB NOT NULL DEFAULT '{}',
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "segments" INTEGER NOT NULL DEFAULT 0,
    "costMinor" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_sms_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_sms_campaigns_tenantId_createdAt_idx" ON "marketing_sms_campaigns"("tenantId", "createdAt");

CREATE TABLE "marketing_sms_recipients" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "segments" INTEGER NOT NULL DEFAULT 0,
    "smsMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_sms_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_sms_recipients_campaignId_phone_key" ON "marketing_sms_recipients"("campaignId", "phone");
CREATE INDEX "marketing_sms_recipients_campaignId_idx" ON "marketing_sms_recipients"("campaignId");

ALTER TABLE "marketing_sms_recipients" ADD CONSTRAINT "marketing_sms_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing_sms_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
