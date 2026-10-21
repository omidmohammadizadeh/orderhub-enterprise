-- Stamp a loyalty card without a sale (Scan loyalty card page).
-- A stamp no longer needs an order; manual stamps are de-duplicated by
-- requestKey instead. Both columns stay unique (Postgres allows many NULLs).
ALTER TABLE "loyalty_stamps" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "loyalty_stamps" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ORDER';
ALTER TABLE "loyalty_stamps" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "loyalty_stamps" ADD COLUMN "staffUserId" TEXT;
CREATE UNIQUE INDEX "loyalty_stamps_requestKey_key" ON "loyalty_stamps"("requestKey");

-- A reward handed over without a sale records who gave it.
ALTER TABLE "loyalty_rewards" ADD COLUMN "claimedByUserId" TEXT;
