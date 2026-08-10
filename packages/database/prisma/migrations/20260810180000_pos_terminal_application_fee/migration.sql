-- Platform fee for card-present charges (S700 / WisePad 3 / Tap to Pay) at a
-- location. Nullable on purpose: NULL inherits the existing brand/location
-- applicationFee* resolution so no live location changes behaviour on deploy,
-- while an explicit 0 means "charge nothing on terminal payments".
ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "posTerminalApplicationFeePercent" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "posTerminalApplicationFeeFixedMinor" INTEGER;
