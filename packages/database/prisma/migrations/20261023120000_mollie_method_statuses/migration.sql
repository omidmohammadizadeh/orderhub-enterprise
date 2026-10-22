-- What Mollie said when we switched on card / Apple Pay for a connected restaurant.
ALTER TABLE "mollie_connections" ADD COLUMN "methodStatuses" JSONB;
