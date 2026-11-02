-- A shop can count dispatched orders in driver pay and cash-up at dispatch.
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "payOnDispatch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "driver_assignments" ADD COLUMN IF NOT EXISTS "creditedAt" TIMESTAMP(3);
