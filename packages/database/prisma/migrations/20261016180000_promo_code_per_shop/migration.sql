-- Promo code text is unique per SHOP, not per tenant: two shops may each have
-- their own "20OFF". Overlap between shops is enforced in PromoCodesService.
-- Created as a table constraint in phase_e, so drop the constraint (the index
-- goes with it); the DROP INDEX covers a database where it is a bare index.
ALTER TABLE "promo_codes" DROP CONSTRAINT IF EXISTS "promo_codes_tenantId_code_key";
DROP INDEX IF EXISTS "promo_codes_tenantId_code_key";
CREATE INDEX "promo_codes_tenantId_code_idx" ON "promo_codes"("tenantId", "code");
