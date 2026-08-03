-- Phase AX — customer web push (PWA order updates)

CREATE TABLE "customer_push_subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "brandId" TEXT,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "customerId" TEXT,
    "deviceRef" TEXT,
    "userAgent" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_push_subscriptions_endpoint_key" ON "customer_push_subscriptions"("endpoint");
CREATE INDEX "customer_push_subscriptions_tenantId_idx" ON "customer_push_subscriptions"("tenantId");
CREATE INDEX "customer_push_subscriptions_customerId_idx" ON "customer_push_subscriptions"("customerId");

CREATE TABLE "customer_push_orders" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_push_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_push_orders_subscriptionId_orderId_key" ON "customer_push_orders"("subscriptionId", "orderId");
CREATE INDEX "customer_push_orders_orderId_idx" ON "customer_push_orders"("orderId");

ALTER TABLE "customer_push_orders"
  ADD CONSTRAINT "customer_push_orders_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "customer_push_subscriptions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
