-- Salon alert sounds: online booking, guest cancellation, walk-in joined.
-- Additive enum values only.
ALTER TYPE "AlertTrigger" ADD VALUE IF NOT EXISTS 'NEW_APPOINTMENT';
ALTER TYPE "AlertTrigger" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CANCELLED';
ALTER TYPE "AlertTrigger" ADD VALUE IF NOT EXISTS 'WALK_IN_JOINED';
