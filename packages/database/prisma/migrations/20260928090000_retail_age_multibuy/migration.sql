-- Retail: age-restricted products + multi-buy offers. Additive only.
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "minAge" INTEGER;
ALTER TYPE "CampaignType" ADD VALUE IF NOT EXISTS 'MULTI_BUY';
