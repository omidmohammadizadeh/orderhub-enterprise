-- Counterparty detail for the parties clause, plus how many premises the
-- agreement covers.
--
-- All nullable: a sole trader has no company number, and a contract should not
-- be blocked on a field the client does not have. The template drops the line
-- when it is blank rather than printing a dangling label.
ALTER TABLE "contracts"
  ADD COLUMN IF NOT EXISTS "recipientCompanyNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "recipientAddress"       TEXT,
  ADD COLUMN IF NOT EXISTS "recipientPhone"         TEXT,
  ADD COLUMN IF NOT EXISTS "locationCount"          INTEGER;
