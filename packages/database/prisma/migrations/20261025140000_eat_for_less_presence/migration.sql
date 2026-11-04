-- Eat For Less: when a shop's own OrderHub device was last connected.
ALTER TABLE "efl_listings" ADD COLUMN "lastDeviceSeenAt" TIMESTAMP(3);
ALTER TABLE "efl_listings" ADD COLUMN "offlineSince" TIMESTAMP(3);
