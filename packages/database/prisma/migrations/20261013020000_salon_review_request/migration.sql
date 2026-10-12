-- Salon — when the "thanks for coming, leave us a review" email went out.
-- A new migration rather than an edit to 20261013000000_salon_s1, which has
-- shipped. IF NOT EXISTS keeps it safe to re-run.
ALTER TABLE "salon_appointments" ADD COLUMN IF NOT EXISTS "reviewRequestSentAt" TIMESTAMP(3);
