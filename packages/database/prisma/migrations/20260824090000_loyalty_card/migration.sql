-- Loyalty stamp cards, per location.
--
-- Six orders, a free thing — the model every takeaway already runs on paper.
-- Per LOCATION rather than per brand because the shop giving the food away is
-- the shop that pays for it.
--
-- isActive defaults FALSE: creating the row must not start giving food away.
-- An operator turns it on once they have set the reward.

CREATE TABLE "loyalty_cards" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT false,
  "stampsRequired"   INTEGER NOT NULL DEFAULT 6,
  "minimumSpend"     DECIMAL(10,2),
  "rewardItemId"     TEXT,
  "rewardLabel"      TEXT NOT NULL DEFAULT 'Free item',
  "rewardExpiryDays" INTEGER,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_cards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loyalty_cards_locationId_key" ON "loyalty_cards"("locationId");
CREATE INDEX "loyalty_cards_tenantId_idx" ON "loyalty_cards"("tenantId");

-- One stamp per ORDER. The unique constraint is the whole defence against
-- double-minting: a webhook replay, a retry or an operator re-opening an
-- order all try to insert the same orderId and lose.
CREATE TABLE "loyalty_stamps" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "cardId"            TEXT NOT NULL,
  "customerAccountId" TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "spend"             DECIMAL(10,2) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_stamps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loyalty_stamps_orderId_key" ON "loyalty_stamps"("orderId");
CREATE INDEX "loyalty_stamps_cardId_customerAccountId_idx" ON "loyalty_stamps"("cardId", "customerAccountId");
CREATE INDEX "loyalty_stamps_tenantId_idx" ON "loyalty_stamps"("tenantId");

-- The label and item are FROZEN on the row. An operator changing tomorrow's
-- reward must not rewrite what this customer was already promised.
CREATE TABLE "loyalty_rewards" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "cardId"            TEXT NOT NULL,
  "customerAccountId" TEXT NOT NULL,
  "label"             TEXT NOT NULL,
  "rewardItemId"      TEXT,
  "earnedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"         TIMESTAMP(3),
  "claimedAt"         TIMESTAMP(3),
  "claimedOrderId"    TEXT,
  CONSTRAINT "loyalty_rewards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loyalty_rewards_claimedOrderId_key" ON "loyalty_rewards"("claimedOrderId");
CREATE INDEX "loyalty_rewards_customerAccountId_claimedAt_idx" ON "loyalty_rewards"("customerAccountId", "claimedAt");
CREATE INDEX "loyalty_rewards_tenantId_idx" ON "loyalty_rewards"("tenantId");

ALTER TABLE "loyalty_cards"  ADD CONSTRAINT "loyalty_cards_locationId_fkey"   FOREIGN KEY ("locationId")   REFERENCES "locations"("id")          ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "loyalty_cards"  ADD CONSTRAINT "loyalty_cards_rewardItemId_fkey" FOREIGN KEY ("rewardItemId") REFERENCES "menu_items"("id")         ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_stamps" ADD CONSTRAINT "loyalty_stamps_cardId_fkey"      FOREIGN KEY ("cardId")       REFERENCES "loyalty_cards"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "loyalty_stamps" ADD CONSTRAINT "loyalty_stamps_customer_fkey"    FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_stamps" ADD CONSTRAINT "loyalty_stamps_orderId_fkey"     FOREIGN KEY ("orderId")      REFERENCES "orders"("id")             ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_cardId_fkey"    FOREIGN KEY ("cardId")       REFERENCES "loyalty_cards"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_customer_fkey"  FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
