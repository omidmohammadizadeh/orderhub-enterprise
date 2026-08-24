-- Referrals, and rewards becoming the shared currency for them.
--
-- A referral reward and a loyalty reward are the same thing to a customer:
-- something on their card that they spend once. Reusing loyalty_rewards means
-- the Rewards tab, the checkout claim, the expiry and the one-time-use
-- guarantee all work for referrals without being written twice.

-- 1. Rewards can now come from no card, know their own shop, and be money off
--    rather than a free item.
ALTER TABLE "loyalty_rewards"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "source"     TEXT NOT NULL DEFAULT 'LOYALTY',
  ADD COLUMN "amountOff"  DECIMAL(10,2);

-- Backfill from the card every existing reward came from, before the column
-- is made NOT NULL — a reward with no shop cannot be spent anywhere.
UPDATE "loyalty_rewards" r
   SET "locationId" = c."locationId"
  FROM "loyalty_cards" c
 WHERE c."id" = r."cardId";

DELETE FROM "loyalty_rewards" WHERE "locationId" IS NULL;

ALTER TABLE "loyalty_rewards" ALTER COLUMN "locationId" SET NOT NULL;
ALTER TABLE "loyalty_rewards" ALTER COLUMN "cardId" DROP NOT NULL;
ALTER TABLE "loyalty_rewards"
  ADD CONSTRAINT "loyalty_rewards_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The programme, per location. isActive defaults FALSE so creating a row
--    never starts paying out.
CREATE TABLE "referral_programs" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT false,
  "referrerAmount"   DECIMAL(10,2) NOT NULL DEFAULT 5,
  "friendAmount"     DECIMAL(10,2) NOT NULL DEFAULT 5,
  "minimumSpend"     DECIMAL(10,2),
  "maxPerCustomer"   INTEGER NOT NULL DEFAULT 10,
  "rewardExpiryDays" INTEGER,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_programs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "referral_programs_locationId_key" ON "referral_programs"("locationId");
CREATE INDEX "referral_programs_tenantId_idx" ON "referral_programs"("tenantId");

-- 3. One reusable code per customer per shop. Reusable on purpose — it is
--    shared with several friends. What is one-time is the reward it produces.
CREATE TABLE "referral_codes" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "programId"         TEXT NOT NULL,
  "customerAccountId" TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");
CREATE UNIQUE INDEX "referral_codes_programId_customerAccountId_key" ON "referral_codes"("programId", "customerAccountId");
CREATE INDEX "referral_codes_tenantId_idx" ON "referral_codes"("tenantId");

-- 4. One friend per referral, and friendAccountId is UNIQUE so a person can
--    only ever be referred once — whoever's code reached them first.
CREATE TABLE "referrals" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "programId"         TEXT NOT NULL,
  "codeId"            TEXT NOT NULL,
  "referrerAccountId" TEXT NOT NULL,
  "friendAccountId"   TEXT NOT NULL,
  "friendPhone"       TEXT,
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "rejectedReason"    TEXT,
  "qualifyingOrderId" TEXT,
  "qualifiedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "referrals_friendAccountId_key" ON "referrals"("friendAccountId");
CREATE UNIQUE INDEX "referrals_qualifyingOrderId_key" ON "referrals"("qualifyingOrderId");
CREATE INDEX "referrals_tenantId_idx" ON "referrals"("tenantId");
CREATE INDEX "referrals_referrerAccountId_status_idx" ON "referrals"("referrerAccountId", "status");

ALTER TABLE "referral_programs" ADD CONSTRAINT "referral_programs_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_programId_fkey" FOREIGN KEY ("programId") REFERENCES "referral_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_customer_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_programId_fkey" FOREIGN KEY ("programId") REFERENCES "referral_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "referral_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_fkey" FOREIGN KEY ("referrerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_friend_fkey" FOREIGN KEY ("friendAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
