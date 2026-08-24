-- Proving a referred friend holds the number they gave.
--
-- The token is per REFERRAL rather than per code: one code is shared with
-- several friends, so a shared token could not tell us which of them just
-- messaged. verifiedPhone is the number the WhatsApp message actually came
-- FROM — Meta guarantees the sender holds it, which is what makes this worth
-- more than the number they typed.
ALTER TABLE "referrals"
  ADD COLUMN "verifyToken"   TEXT,
  ADD COLUMN "verifiedPhone" TEXT,
  ADD COLUMN "verifiedAt"    TIMESTAMP(3);

CREATE UNIQUE INDEX "referrals_verifyToken_key" ON "referrals"("verifyToken");
