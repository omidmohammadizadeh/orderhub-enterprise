-- Phase K: Live client onboarding and go-live lifecycle

-- New enum for location go-live status
CREATE TYPE "LocationGoLiveStatus" AS ENUM (
  'DRAFT',
  'CONFIGURING',
  'TESTING',
  'READY_FOR_GO_LIVE',
  'LIVE',
  'PAUSED',
  'BLOCKED'
);

-- Add go-live lifecycle fields to locations
ALTER TABLE "locations" ADD COLUMN "goLiveStatus" "LocationGoLiveStatus" NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "locations" ADD COLUMN "lastTestOrderAt" TIMESTAMP(3);
ALTER TABLE "locations" ADD COLUMN "lastTestPrintAt" TIMESTAMP(3);

-- Index for querying locations by go-live status (e.g. show all READY_FOR_GO_LIVE)
CREATE INDEX "locations_goLiveStatus_idx" ON "locations"("goLiveStatus");
