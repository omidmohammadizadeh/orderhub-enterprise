-- Phase AY — WhatsApp ordering channel. Idempotent.

-- New channel enum values (safe to use within a transaction on PG12+ since they
-- are not referenced by a DEFAULT in this same migration).
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'WHATSAPP';

-- Conversation / cart state for the WhatsApp ordering bot.
CREATE TABLE IF NOT EXISTS "whatsapp_conversations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "brandId" TEXT,
    "waPhone" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'IDLE',
    "cart" JSONB,
    "customerName" TEXT,
    "lastOrderId" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_conversations_phoneNumberId_waPhone_key" ON "whatsapp_conversations" ("phoneNumberId", "waPhone");
CREATE INDEX IF NOT EXISTS "whatsapp_conversations_tenantId_waPhone_idx" ON "whatsapp_conversations" ("tenantId", "waPhone");
