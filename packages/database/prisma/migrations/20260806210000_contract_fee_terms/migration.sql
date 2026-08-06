-- Optional commercial terms on a contract.
--
-- Both nullable on purpose: NULL means the clause does not appear in the
-- agreement at all. Storing 0 would print "0%", which reads as a term
-- negotiated down to nothing rather than one that was never offered.
ALTER TABLE "contracts"
  ADD COLUMN IF NOT EXISTS "commissionPercent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "customerServiceChargePence" INTEGER;
