-- Walk-in loyalty cards: joined at the counter, kept in Apple/Google Wallet,
-- scanned at the till. Same stamps and reward as the online card.

ALTER TABLE "loyalty_cards" ADD COLUMN "walkInEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "loyalty_cards" ADD COLUMN "cardTitle" TEXT;
ALTER TABLE "loyalty_cards" ADD COLUMN "cardColor" TEXT;
ALTER TABLE "loyalty_cards" ADD COLUMN "cardLogoUrl" TEXT;

CREATE TABLE "loyalty_members" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "cardId"           TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "code"             TEXT NOT NULL,
  "publicToken"      TEXT NOT NULL,
  "phone"            TEXT,
  "firstName"        TEXT,
  "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
  "source"           TEXT NOT NULL DEFAULT 'SELF',
  "passUpdatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "googleObjectAt"   TIMESTAMP(3),
  "lastSeenAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loyalty_members_code_key" ON "loyalty_members"("code");
CREATE UNIQUE INDEX "loyalty_members_publicToken_key" ON "loyalty_members"("publicToken");
CREATE UNIQUE INDEX "loyalty_members_cardId_phone_key" ON "loyalty_members"("cardId", "phone");
CREATE INDEX "loyalty_members_tenantId_idx" ON "loyalty_members"("tenantId");
CREATE INDEX "loyalty_members_locationId_idx" ON "loyalty_members"("locationId");
ALTER TABLE "loyalty_members" ADD CONSTRAINT "loyalty_members_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "loyalty_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "loyalty_pass_devices" (
  "id"              TEXT NOT NULL,
  "memberId"        TEXT NOT NULL,
  "deviceLibraryId" TEXT NOT NULL,
  "pushToken"       TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_pass_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loyalty_pass_devices_deviceLibraryId_memberId_key" ON "loyalty_pass_devices"("deviceLibraryId", "memberId");
CREATE INDEX "loyalty_pass_devices_deviceLibraryId_idx" ON "loyalty_pass_devices"("deviceLibraryId");
ALTER TABLE "loyalty_pass_devices" ADD CONSTRAINT "loyalty_pass_devices_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "loyalty_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A stamp or reward now belongs to an online account OR a walk-in member.
ALTER TABLE "loyalty_stamps" ALTER COLUMN "customerAccountId" DROP NOT NULL;
ALTER TABLE "loyalty_stamps" ADD COLUMN "memberId" TEXT;
CREATE INDEX "loyalty_stamps_cardId_memberId_idx" ON "loyalty_stamps"("cardId", "memberId");
ALTER TABLE "loyalty_stamps" ADD CONSTRAINT "loyalty_stamps_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "loyalty_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "loyalty_rewards" ALTER COLUMN "customerAccountId" DROP NOT NULL;
ALTER TABLE "loyalty_rewards" ADD COLUMN "memberId" TEXT;
CREATE INDEX "loyalty_rewards_memberId_claimedAt_idx" ON "loyalty_rewards"("memberId", "claimedAt");
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "loyalty_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "orders" ADD COLUMN "loyaltyMemberId" TEXT;
