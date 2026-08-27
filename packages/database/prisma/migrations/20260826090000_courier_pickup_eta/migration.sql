-- When the courier is expected to reach the SHOP.
--
-- Deliberately NOT courierEtaAt, which is when they reach the CUSTOMER and is
-- what auto-completes a platform-courier order. Writing a pickup estimate into
-- that column would close orders the moment a rider arrived at the door.
ALTER TABLE "orders" ADD COLUMN "courierPickupEtaAt" TIMESTAMP(3);
