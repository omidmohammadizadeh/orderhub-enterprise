-- Phase MK-INSIGHTS — per-order marketing campaign attribution.
--
-- campaign_redemptions: one row each time a MarketingCampaign discount
-- actually applied to an order, so the Marketing page can show real
-- per-campaign performance (Sales/Orders/New customers) over a date
-- range, like Uber Eats Manager's "Offers" view. Written best-effort at
-- checkout; a missing row never fails an order. Attribution is
-- forward-only — orders placed before this shipped have no rows.

-- CreateTable
CREATE TABLE "campaign_redemptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'ONLINE',
    "customerAccountId" TEXT,
    "isNewCustomer" BOOLEAN NOT NULL DEFAULT false,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "orderTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_redemptions_orderId_campaignId_key" ON "campaign_redemptions"("orderId", "campaignId");

-- CreateIndex
CREATE INDEX "campaign_redemptions_campaignId_createdAt_idx" ON "campaign_redemptions"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "campaign_redemptions_tenantId_idx" ON "campaign_redemptions"("tenantId");

-- CreateIndex
CREATE INDEX "campaign_redemptions_brandId_idx" ON "campaign_redemptions"("brandId");

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
