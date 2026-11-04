-- Eat For Less Phase 4: delivery PIN attempts and private call lines.
-- Additive only.

ALTER TABLE "orders" ADD COLUMN "deliveryPinAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "efl_call_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "driverCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "efl_call_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "efl_call_lines_orderId_key" ON "efl_call_lines"("orderId");
CREATE INDEX "efl_call_lines_customerCode_idx" ON "efl_call_lines"("customerCode");
CREATE INDEX "efl_call_lines_driverCode_idx" ON "efl_call_lines"("driverCode");
