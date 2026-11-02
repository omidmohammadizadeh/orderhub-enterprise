-- A short per-shop ticket number, restarting each trading day. Additive: existing
-- orders keep a null ticket number and Order ID is untouched.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ticketNumber" INTEGER;

CREATE TABLE IF NOT EXISTS "order_ticket_sequences" (
    "locationId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_ticket_sequences_pkey" PRIMARY KEY ("locationId","businessDate")
);
