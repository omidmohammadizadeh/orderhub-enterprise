-- Phase AV-3 — anonymised-call PIN for the marketplace courier.
--
-- HubRise routes platform-courier calls through the marketplace's
-- masking number; the PIN looks up which active delivery the call
-- belongs to. Without the code, dialling the courierPhone never
-- connects.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "courierPhoneAccessCode" TEXT;
