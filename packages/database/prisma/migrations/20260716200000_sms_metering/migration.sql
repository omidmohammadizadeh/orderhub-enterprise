-- SMS metering ledger (payment links + marketing), for pass-through billing.
CREATE TABLE "sms_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "brandId" TEXT,
    "orderId" TEXT,
    "toNumber" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL DEFAULT 'TWILIO',
    "providerSid" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sms_messages_tenantId_createdAt_idx" ON "sms_messages"("tenantId", "createdAt");
CREATE INDEX "sms_messages_tenantId_locationId_createdAt_idx" ON "sms_messages"("tenantId", "locationId", "createdAt");
