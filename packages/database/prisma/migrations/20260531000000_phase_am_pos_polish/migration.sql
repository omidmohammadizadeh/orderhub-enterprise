-- Phase AM polish — sequential POS order numbers + tenant counter.
--
-- POS / DIRECT orders get a small monotonic integer per tenant
-- ("#1", "#2", "#3", …) that operators can shout across the kitchen.
-- External marketplace orders (Just Eat / Uber Eats / Deliveroo /
-- HubRise) keep their own platform-issued displayId so customer-service
-- lookups still work.
--
-- We store the counter in its own table — incrementing on the row
-- inside a SERIALIZABLE transaction is race-free and avoids the
-- pitfalls of doing MAX(orderNumber)+1 under load.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "orderNumber" INT;

CREATE INDEX IF NOT EXISTS "orders_tenantId_orderNumber_idx"
  ON "orders"("tenantId", "orderNumber");

CREATE TABLE IF NOT EXISTS "order_number_sequences" (
  "tenantId"  TEXT NOT NULL,
  "nextValue" INT NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "order_number_sequences_pkey" PRIMARY KEY ("tenantId")
);
