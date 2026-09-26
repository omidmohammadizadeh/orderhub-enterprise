-- Phase BJ — JET Go (Just Eat Takeaway Delivery-as-a-Service) courier dispatch,
-- per location. Same shape as stuart_configs / uber_direct_configs, plus the two
-- fields JET Go needs that the others don't: the onboarded collect point id (JET
-- takes a pickup POINT, not a pickup address) and a webhookToken that is shared
-- between locations using the same client credential, because JET allows only
-- one notification config per credential. webhookToken is the path segment (safe
-- to display) and webhookSecret is the credential JET sends back — two different
-- values on purpose, so copying the URL never leaks the secret.

CREATE TABLE "jet_go_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'UK',
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "credentials" JSONB NOT NULL,
    "collectPointId" TEXT,
    "collectPointName" TEXT,
    "webhookToken" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jet_go_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jet_go_configs_locationId_key" ON "jet_go_configs"("locationId");
CREATE INDEX "jet_go_configs_tenantId_idx" ON "jet_go_configs"("tenantId");
-- The inbound webhook looks a config up by this token on every JET callback.
CREATE INDEX "jet_go_configs_webhookToken_idx" ON "jet_go_configs"("webhookToken");

ALTER TABLE "jet_go_configs"
    ADD CONSTRAINT "jet_go_configs_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
