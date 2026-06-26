-- Phase AX — multi-drop dispatch: stop sequence + arrival timestamp on assignments.
-- Idempotent.
ALTER TABLE "driver_assignments" ADD COLUMN IF NOT EXISTS "sequence" INTEGER;
ALTER TABLE "driver_assignments" ADD COLUMN IF NOT EXISTS "arrivedAt" TIMESTAMP(3);
