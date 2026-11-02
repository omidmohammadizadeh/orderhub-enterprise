-- Shared per-location tablet sign-in (Team → Tablet logins). Additive — no
-- existing user or route is affected; only accounts created with this role
-- ever carry it.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'LOCATION_TABLET';
