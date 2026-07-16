-- Location-scope marketing SMS: contacts + campaigns belong to a location.

ALTER TABLE "marketing_contacts" ADD COLUMN "locationId" TEXT;
ALTER TABLE "marketing_sms_campaigns" ADD COLUMN "locationId" TEXT;

-- Swap the dedupe key to include location (same phone can exist per location).
DROP INDEX IF EXISTS "marketing_contacts_tenantId_phone_key";
CREATE UNIQUE INDEX "marketing_contacts_tenantId_locationId_phone_key"
  ON "marketing_contacts"("tenantId", "locationId", "phone");
CREATE INDEX "marketing_contacts_tenantId_locationId_consentStatus_idx"
  ON "marketing_contacts"("tenantId", "locationId", "consentStatus");
