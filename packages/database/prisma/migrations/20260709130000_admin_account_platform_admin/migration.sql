-- The account admin@orderhub.io is the platform operator and must have full,
-- unrestricted access (the true super-admin role), not the tenant-scoped
-- TENANT_OWNER it was promoted to earlier. Promote it to PLATFORM_ADMIN.
-- Idempotent: only touches the row when it isn't already PLATFORM_ADMIN, so
-- re-running (or running after a manual fix) is a no-op.
UPDATE "users"
SET "role" = 'PLATFORM_ADMIN'::"UserRole"
WHERE "email" = 'admin@orderhub.io'
  AND "role" <> 'PLATFORM_ADMIN'::"UserRole";
