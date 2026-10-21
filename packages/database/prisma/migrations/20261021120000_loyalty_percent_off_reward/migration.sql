-- Loyalty card reward can be a percentage off the order, not only a free item.
ALTER TABLE "loyalty_cards" ADD COLUMN "rewardType" TEXT NOT NULL DEFAULT 'FREE_ITEM';
ALTER TABLE "loyalty_cards" ADD COLUMN "rewardPercent" INTEGER;
ALTER TABLE "loyalty_cards" ADD COLUMN "rewardMaxDiscount" DECIMAL(10,2);
ALTER TABLE "loyalty_cards" ADD COLUMN "rewardMinOrder" DECIMAL(10,2);

-- Frozen onto each reward when it is earned.
ALTER TABLE "loyalty_rewards" ADD COLUMN "percentOff" INTEGER;
ALTER TABLE "loyalty_rewards" ADD COLUMN "maxDiscount" DECIMAL(10,2);
ALTER TABLE "loyalty_rewards" ADD COLUMN "minOrder" DECIMAL(10,2);
