-- One-time code for re-opening an existing walk-in card on another phone.
ALTER TABLE "loyalty_members" ADD COLUMN "verifyCodeHash" TEXT;
ALTER TABLE "loyalty_members" ADD COLUMN "verifyExpiresAt" TIMESTAMP(3);
ALTER TABLE "loyalty_members" ADD COLUMN "verifyAttempts" INTEGER NOT NULL DEFAULT 0;
