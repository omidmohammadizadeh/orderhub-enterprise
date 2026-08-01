-- Group ordering: a shared basket several people add to before it becomes one
-- order. Additive and idempotent — safe to re-run on boot.

CREATE TABLE IF NOT EXISTS "group_orders" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "locationId"      TEXT NOT NULL,
  "brandId"         TEXT,
  "hostCustomerId"  TEXT,
  "hostName"        TEXT,
  "status"          TEXT NOT NULL DEFAULT 'OPEN',
  "orderId"         TEXT,
  "fulfillmentType" TEXT NOT NULL DEFAULT 'DELIVERY',
  "paymentMode"     TEXT NOT NULL DEFAULT 'HOST_PAYS',
  "expiresAt"       TIMESTAMP(3),
  "placedAt"        TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_orders_token_key"   ON "group_orders"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "group_orders_orderId_key" ON "group_orders"("orderId");
CREATE INDEX IF NOT EXISTS "group_orders_tenantId_status_idx"   ON "group_orders"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "group_orders_locationId_status_idx" ON "group_orders"("locationId", "status");

CREATE TABLE IF NOT EXISTS "group_order_items" (
  "id"           TEXT NOT NULL,
  "groupOrderId" TEXT NOT NULL,
  "addedByName"  TEXT NOT NULL,
  "addedByRef"   TEXT NOT NULL,
  "cartItem"     JSONB NOT NULL,
  "quantity"     INTEGER NOT NULL DEFAULT 1,
  "lineTotal"    DOUBLE PRECISION NOT NULL,
  "isPaid"       BOOLEAN NOT NULL DEFAULT false,
  "paidAt"       TIMESTAMP(3),
  "paymentId"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_order_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "group_order_items_groupOrderId_idx"            ON "group_order_items"("groupOrderId");
CREATE INDEX IF NOT EXISTS "group_order_items_groupOrderId_addedByRef_idx" ON "group_order_items"("groupOrderId", "addedByRef");
