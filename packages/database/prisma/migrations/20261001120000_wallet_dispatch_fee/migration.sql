-- Per-location OrderHub fee per courier dispatch, in pennies.
--
-- NULL means "use the platform default" (DISPATCH_FEE_MINOR, 50p), which is what
-- every existing wallet keeps. Same shape as voicePricePerCallMinor: an override
-- a platform admin sets per shop, never visible to the shop's own staff.
ALTER TABLE "wallets" ADD COLUMN "dispatchFeeMinor" INTEGER;
