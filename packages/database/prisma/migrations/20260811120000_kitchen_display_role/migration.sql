-- Device role for a kitchen screen: reaches the Kitchen Display and nothing
-- else, mirroring KIOSK. Additive — no existing user is affected.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'KITCHEN_DISPLAY';
