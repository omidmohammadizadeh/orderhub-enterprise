-- Soft delete for contracts.
--
-- A signed contract records an agreement somebody is bound by, and its event
-- trail is the evidence behind it. A hard DELETE would destroy both just to
-- tidy a list, so removal hides the row instead.
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "contracts_tenantId_deletedAt_idx"
  ON "contracts"("tenantId", "deletedAt");
