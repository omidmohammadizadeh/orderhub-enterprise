-- Placed fields on an uploaded contract PDF.
--
-- Geometry is fractional (0..1) rather than pixels so a box placed on a
-- desktop editor lands in the same spot when a signer opens it on a phone,
-- and so the same record survives any future change of render scale.
CREATE TABLE IF NOT EXISTS "contract_fields" (
    "id"         TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "page"       INTEGER NOT NULL,
    "x"          DOUBLE PRECISION NOT NULL,
    "y"          DOUBLE PRECISION NOT NULL,
    "w"          DOUBLE PRECISION NOT NULL,
    "h"          DOUBLE PRECISION NOT NULL,
    "type"       TEXT NOT NULL,
    "assignee"   TEXT NOT NULL DEFAULT 'RECIPIENT',
    "label"      TEXT,
    "required"   BOOLEAN NOT NULL DEFAULT true,
    "fontSize"   INTEGER NOT NULL DEFAULT 11,
    "value"      TEXT,
    "sortOrder"  INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "contract_fields_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "contract_fields_contractId_idx"
    ON "contract_fields"("contractId");

-- Cascade: a deleted contract must not leave orphaned boxes behind.
DO $$ BEGIN
  ALTER TABLE "contract_fields"
    ADD CONSTRAINT "contract_fields_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "contracts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
