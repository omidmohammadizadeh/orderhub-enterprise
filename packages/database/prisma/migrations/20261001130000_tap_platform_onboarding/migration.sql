-- Tap Platform model — Tap issued us PLATFORM accounts (Commerce / Billing /
-- App), not the marketplace the Aug 2026 build assumed. Each brand now has its
-- own Tap merchant that charges are routed to, onboarded through Tap's
-- Lead → Connect flow. Purely additive; the old marketplace columns stay.

ALTER TABLE "brands" ADD COLUMN "tapMerchantId" TEXT;
ALTER TABLE "brands" ADD COLUMN "tapLeadId" TEXT;
ALTER TABLE "brands" ADD COLUMN "tapOnboardingStatus" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "brands" ADD COLUMN "tapConnectUrl" TEXT;
