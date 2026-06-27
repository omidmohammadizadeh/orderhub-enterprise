-- Phase AX-4 — dispatch chat (operator↔driver + customer↔driver). Idempotent.
CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "driverId" TEXT,
    "orderId" TEXT,
    "senderType" TEXT NOT NULL,
    "senderName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readByOperatorAt" TIMESTAMP(3),
    "readByDriverAt" TIMESTAMP(3),
    "readByCustomerAt" TIMESTAMP(3),
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_messages_tenantId_driverId_createdAt_idx" ON "chat_messages" ("tenantId", "driverId", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_messages_orderId_createdAt_idx" ON "chat_messages" ("orderId", "createdAt");
