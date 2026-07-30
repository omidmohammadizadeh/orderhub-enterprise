-- KIOSK user role: a self-service device signs in as its own restricted user.
-- Additive enum value; guarded so the migration is safe to re-run.
DO $$ BEGIN
  ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'KIOSK';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
