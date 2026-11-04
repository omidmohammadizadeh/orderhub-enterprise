-- Eat For Less Phase 5: sponsored listings and weekly statements. Additive only.

ALTER TABLE "orders" ADD COLUMN "eflAdRecovered" DECIMAL(10,2);
ALTER TABLE "efl_listings" ADD COLUMN "statementEmail" TEXT;

CREATE TABLE "efl_ad_campaigns" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "weeklyBudget" DECIMAL(10,2) NOT NULL,
    "maxBid" DECIMAL(10,2) NOT NULL,
    "pausedByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_ad_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_ad_campaigns_listingId_key" ON "efl_ad_campaigns"("listingId");
ALTER TABLE "efl_ad_campaigns" ADD CONSTRAINT "efl_ad_campaigns_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "efl_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "efl_ad_taps" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "cost" DECIMAL(10,2) NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "efl_ad_taps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "efl_ad_taps_listingId_createdAt_idx" ON "efl_ad_taps"("listingId", "createdAt");
CREATE INDEX "efl_ad_taps_viewerKey_listingId_createdAt_idx" ON "efl_ad_taps"("viewerKey", "listingId", "createdAt");

CREATE TABLE "efl_ad_shows" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "efl_ad_shows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_ad_shows_listingId_viewerKey_day_key" ON "efl_ad_shows"("listingId", "viewerKey", "day");
CREATE INDEX "efl_ad_shows_listingId_day_idx" ON "efl_ad_shows"("listingId", "day");

CREATE TABLE "efl_statement_sends" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "sentTo" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "efl_statement_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "efl_statement_sends_listingId_weekStart_key" ON "efl_statement_sends"("listingId", "weekStart");

CREATE TABLE "efl_campaigns" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "targeted" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "efl_campaigns_createdAt_idx" ON "efl_campaigns"("createdAt");
