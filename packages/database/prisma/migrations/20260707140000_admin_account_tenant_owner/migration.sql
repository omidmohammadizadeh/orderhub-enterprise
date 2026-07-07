-- The platform admin account (admin@orderhub.io) was stored with the
-- scoped OWNER (location-owner) role, which limited it to its assigned
-- locations/brands. It is the account Admin and must have full tenant
-- access, so promote it to TENANT_OWNER. Idempotent: only touches the row
-- when it's still OWNER, so re-running (or running after a manual fix) is
-- a no-op. OWNER stays a distinct scoped role for actual location owners.
UPDATE "users"
SET "role" = 'TENANT_OWNER'::"UserRole"
WHERE "email" = 'admin@orderhub.io'
  AND "role" = 'OWNER'::"UserRole";
