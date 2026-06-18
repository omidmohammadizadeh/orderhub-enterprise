-- Phase AW-19 — Marketing campaigns.
--
-- One row per brand-channel campaign. Type column drives which
-- type-specific columns are read (a percentage-off campaign uses
-- percentageOff + minOrder, a free-delivery campaign uses minOrder
-- only, etc). Storefront + POS read ACTIVE rows at order time and
-- apply the best match for the customer's audience bucket.
--
-- Idempotent. Enums use CREATE TYPE IF NOT EXISTS-equivalent
-- DO blocks so a half-applied retry replays cleanly.

DO $$ BEGIN
  CREATE TYPE "CampaignType" AS ENUM (
    'PERCENTAGE_OFF',
    'AMOUNT_OFF_ORDER',
    'PERCENT_OFF_ITEMS',
    'BOGO',
    'FREE_ITEM',
    'FREE_DELIVERY',
    'HAPPY_HOUR'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignAudience" AS ENUM ('ALL', 'NEW', 'RETURNING', 'LAPSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "brandId"          TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "description"      TEXT,
  "type"             "CampaignType" NOT NULL,
  "status"           "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "audience"         "CampaignAudience" NOT NULL DEFAULT 'ALL',
  "channels"         TEXT[] NOT NULL DEFAULT '{}',
  "percentageOff"    DECIMAL(5,2),
  "amountOff"        DECIMAL(10,2),
  "minOrder"         DECIMAL(10,2),
  "freeItemId"       TEXT,
  "itemIds"          TEXT[] NOT NULL DEFAULT '{}',
  "dailyStartTime"   TEXT,
  "dailyEndTime"     TEXT,
  "startsAt"         TIMESTAMP(3),
  "endsAt"           TIMESTAMP(3),
  "maxRedemptions"   INTEGER,
  "perCustomerLimit" INTEGER,
  "redemptionCount"  INTEGER NOT NULL DEFAULT 0,
  "metadata"         JSONB NOT NULL DEFAULT '{}',
  "createdBy"        TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "marketing_campaigns_tenantId_idx"
  ON "marketing_campaigns" ("tenantId");

CREATE INDEX IF NOT EXISTS "marketing_campaigns_brandId_idx"
  ON "marketing_campaigns" ("brandId");

CREATE INDEX IF NOT EXISTS "marketing_campaigns_tenantId_status_idx"
  ON "marketing_campaigns" ("tenantId", "status");

CREATE INDEX IF NOT EXISTS "marketing_campaigns_brandId_status_idx"
  ON "marketing_campaigns" ("brandId", "status");

ALTER TABLE "marketing_campaigns"
  DROP CONSTRAINT IF EXISTS "marketing_campaigns_tenantId_fkey";

ALTER TABLE "marketing_campaigns"
  ADD CONSTRAINT "marketing_campaigns_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "marketing_campaigns"
  DROP CONSTRAINT IF EXISTS "marketing_campaigns_brandId_fkey";

ALTER TABLE "marketing_campaigns"
  ADD CONSTRAINT "marketing_campaigns_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE;
