-- Promo codes: "once per customer". A per-customer limit on the code, and a
-- record of who used it on which order. Purely additive.

ALTER TABLE "promo_codes" ADD COLUMN IF NOT EXISTS "maxUsesPerCustomer" INTEGER;

CREATE TABLE IF NOT EXISTS "promo_code_redemptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerAccountId" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_code_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_redemptions_promoCodeId_orderId_key" ON "promo_code_redemptions"("promoCodeId", "orderId");
CREATE INDEX IF NOT EXISTS "promo_code_redemptions_promoCodeId_customerAccountId_idx" ON "promo_code_redemptions"("promoCodeId", "customerAccountId");
CREATE INDEX IF NOT EXISTS "promo_code_redemptions_promoCodeId_customerEmail_idx" ON "promo_code_redemptions"("promoCodeId", "customerEmail");

DO $$ BEGIN
  ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
