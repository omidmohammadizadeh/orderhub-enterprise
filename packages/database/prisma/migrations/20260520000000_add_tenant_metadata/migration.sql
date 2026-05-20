-- AddColumn: tenants.metadata
-- metadata was added to schema.prisma but never included in a migration.
-- Uses IF NOT EXISTS so the statement is idempotent if the column was applied
-- manually before this migration ran via prisma migrate deploy.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';
