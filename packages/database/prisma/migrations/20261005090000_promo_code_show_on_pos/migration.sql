-- Promo codes: whether the till shows the code as a quick discount button.
-- Codes created for email offers were showing up as till buttons; switch
-- those off. Everything else keeps today's behaviour (shown).

ALTER TABLE "promo_codes" ADD COLUMN IF NOT EXISTS "showOnPos" BOOLEAN NOT NULL DEFAULT true;

UPDATE "promo_codes" SET "showOnPos" = false WHERE "description" = 'Email campaign offer';
