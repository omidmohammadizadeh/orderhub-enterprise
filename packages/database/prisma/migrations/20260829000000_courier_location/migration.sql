-- Where a marketplace/third-party courier is right now, when the provider
-- tells us. Deliveroo sends lat/lon on every rider event; Uber Direct and
-- Stuart send a courier location on theirs. Uber Eats marketplace, Just Eat
-- and HubRise-relayed orders send no coordinates at all.
ALTER TABLE "orders" ADD COLUMN "courierLat" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN "courierLng" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN "courierLocationAt" TIMESTAMP(3);
