-- Eat For Less app: push devices, saved addresses and favourite shops.

CREATE TABLE "efl_push_devices" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_push_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_push_devices_token_key" ON "efl_push_devices"("token");
CREATE INDEX "efl_push_devices_customerAccountId_idx" ON "efl_push_devices"("customerAccountId");

CREATE TABLE "efl_saved_addresses" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "label" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "instructions" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_saved_addresses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "efl_saved_addresses_customerAccountId_idx" ON "efl_saved_addresses"("customerAccountId");

CREATE TABLE "efl_favourites" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "efl_favourites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_favourites_customerAccountId_listingId_key" ON "efl_favourites"("customerAccountId", "listingId");
