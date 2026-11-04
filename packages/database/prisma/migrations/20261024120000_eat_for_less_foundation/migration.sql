-- Eat For Less foundation: the channel, shop listings, platform settings,
-- phone verification, and the order fields the app needs.

ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'EAT_FOR_LESS';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'EAT_FOR_LESS';

CREATE TYPE "EflListingStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED');
CREATE TYPE "EflDeliveryMode" AS ENUM ('OWN_DRIVERS', 'COURIER', 'OWN_THEN_COURIER');

CREATE TABLE "efl_listings" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "brandId" TEXT,
    "listed" BOOLEAN NOT NULL DEFAULT false,
    "status" "EflListingStatus" NOT NULL DEFAULT 'PENDING',
    "hiddenReason" TEXT,
    "commissionPercent" DECIMAL(5,2),
    "deliveryMode" "EflDeliveryMode" NOT NULL DEFAULT 'OWN_DRIVERS',
    "acceptsDelivery" BOOLEAN NOT NULL DEFAULT true,
    "acceptsCollection" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "heroImageUrl" TEXT,
    "logoUrl" TEXT,
    "cuisines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_listings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_listings_locationId_key" ON "efl_listings"("locationId");
CREATE INDEX "efl_listings_status_listed_idx" ON "efl_listings"("status", "listed");
ALTER TABLE "efl_listings" ADD CONSTRAINT "efl_listings_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "efl_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "defaultCommissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 8,
    "pinMinOrderTotal" DECIMAL(10,2) NOT NULL DEFAULT 25,
    "pinForNewCustomers" BOOLEAN NOT NULL DEFAULT true,
    "firstOrderMaxTotal" DECIMAL(10,2) NOT NULL DEFAULT 60,
    "maxOrdersPerHour" INTEGER NOT NULL DEFAULT 3,
    "minHygieneRating" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "efl_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "efl_phone_verifications" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "efl_phone_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "efl_phone_verifications_customerAccountId_createdAt_idx"
    ON "efl_phone_verifications"("customerAccountId", "createdAt");

ALTER TABLE "customer_accounts" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
ALTER TABLE "customer_accounts" ADD COLUMN "eflMarketingOptIn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "orders" ADD COLUMN "deliveryPin" TEXT;
ALTER TABLE "orders" ADD COLUMN "deliveryPinVerifiedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "eflCommissionPercent" DECIMAL(5,2);
