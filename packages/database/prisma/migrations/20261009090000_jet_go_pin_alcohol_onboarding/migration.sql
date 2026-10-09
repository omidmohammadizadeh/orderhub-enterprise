-- JET Go: PIN proof of delivery, alcohol handling, and collect-point onboarding.
-- Age restriction itself reuses the existing menu_items.minAge column.

ALTER TABLE "jet_go_configs" ADD COLUMN "requirePinOnDelivery" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "jet_go_configs" ADD COLUMN "alcoholAgeRestriction" INTEGER NOT NULL DEFAULT 18;
ALTER TABLE "jet_go_configs" ADD COLUMN "alcoholIdScan" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "jet_go_configs" ADD COLUMN "onboardingReference" TEXT;
ALTER TABLE "jet_go_configs" ADD COLUMN "onboardingStatus" TEXT;
ALTER TABLE "jet_go_configs" ADD COLUMN "onboardingError" TEXT;
ALTER TABLE "jet_go_configs" ADD COLUMN "onboardingAt" TIMESTAMP(3);
