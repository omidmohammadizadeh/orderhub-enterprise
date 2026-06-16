-- Phase AV — delivery type + courier tracking on Order.
--
-- deliveryType distinguishes restaurant-driven (MERCHANT) from
-- marketplace-courier (PLATFORM) orders so the dashboard can gate
-- post-READY operator transitions on PLATFORM orders and surface a
-- "Delivery" column on the Orders board.
--
-- Courier columns are populated by HubRise's delivery.create /
-- delivery.update webhook handler; kept as flat columns instead of
-- metadata JSON so the dashboard can render them without parsing.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "deliveryType"        TEXT,
  ADD COLUMN IF NOT EXISTS "courierName"         TEXT,
  ADD COLUMN IF NOT EXISTS "courierPhone"        TEXT,
  ADD COLUMN IF NOT EXISTS "courierTrackingUrl"  TEXT,
  ADD COLUMN IF NOT EXISTS "courierStatus"       TEXT,
  ADD COLUMN IF NOT EXISTS "courierAssignedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "courierPickedUpAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "courierDeliveredAt"  TIMESTAMP(3);

-- Index used by the Orders board's "Delivery" filter chip.
CREATE INDEX IF NOT EXISTS "orders_deliveryType_idx"
  ON "orders"("deliveryType");
