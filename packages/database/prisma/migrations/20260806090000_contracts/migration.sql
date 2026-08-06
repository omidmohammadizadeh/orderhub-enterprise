-- Contracts (e-signature): templates, sent contracts, and the audit trail.
--
-- Written by hand rather than generated because local dev has used `db push`
-- in the past, so the migration history and the live schema can drift. Every
-- statement is IF NOT EXISTS so a re-run on a database that already has these
-- tables is a no-op rather than a failed deploy.

CREATE TABLE IF NOT EXISTS "contract_templates" (
  "id"                      TEXT NOT NULL,
  "tenantId"                TEXT NOT NULL,
  "name"                    TEXT NOT NULL,
  "description"             TEXT,
  "bodyHtml"                TEXT,
  "fileUrl"                 TEXT,
  "fileName"                TEXT,
  "fileType"                TEXT,
  "subscriptionAmountPence" INTEGER,
  "createdByUserId"         TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"               TIMESTAMP(3),
  CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "contracts" (
  "id"                      TEXT NOT NULL,
  "tenantId"                TEXT NOT NULL,
  "templateId"              TEXT,
  "locationId"              TEXT,
  "title"                   TEXT NOT NULL,
  "bodyHtml"                TEXT,
  "fileUrl"                 TEXT,
  "fileName"                TEXT,
  "fileType"                TEXT,
  "recipientName"           TEXT NOT NULL,
  "recipientEmail"          TEXT NOT NULL,
  "recipientCompany"        TEXT,
  "subscriptionAmountPence" INTEGER,
  "status"                  TEXT NOT NULL DEFAULT 'DRAFT',
  "token"                   TEXT NOT NULL,
  "sentAt"                  TIMESTAMP(3),
  "firstOpenedAt"           TIMESTAMP(3),
  "signedAt"                TIMESTAMP(3),
  "voidedAt"                TIMESTAMP(3),
  "lastRemindedAt"          TIMESTAMP(3),
  "signerName"              TEXT,
  "signerEmail"             TEXT,
  "signatureImageUrl"       TEXT,
  "signerIp"                TEXT,
  "signerUserAgent"         TEXT,
  "subscriptionStartedAt"   TIMESTAMP(3),
  "createdByUserId"         TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "contract_events" (
  "id"         TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "ip"         TEXT,
  "userAgent"  TEXT,
  "meta"       JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contract_events_pkey" PRIMARY KEY ("id")
);

-- The signing link is the only credential, so the token must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_token_key" ON "contracts"("token");

CREATE INDEX IF NOT EXISTS "contract_templates_tenantId_idx" ON "contract_templates"("tenantId");
CREATE INDEX IF NOT EXISTS "contracts_tenantId_status_idx"   ON "contracts"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "contracts_locationId_idx"        ON "contracts"("locationId");
CREATE INDEX IF NOT EXISTS "contract_events_contractId_createdAt_idx"
  ON "contract_events"("contractId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deleting a template must not delete agreements already signed against it,
-- and the contract carries its own frozen copy of the body anyway.
DO $$ BEGIN
  ALTER TABLE "contracts" ADD CONSTRAINT "contracts_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "contract_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "contracts" ADD CONSTRAINT "contracts_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
