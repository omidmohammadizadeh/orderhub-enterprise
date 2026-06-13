-- Phase AR — leads / contact requests.
--
-- Captures submissions from two surfaces:
--   1. The no-access screen shown to a freshly created user who has
--      no locations assigned yet — "Request a demo".
--   2. The marketing-site contact form (when that lands).
-- Surfaced to platform admin + onboarding agents at /dashboard/leads.

CREATE TYPE "LeadStatus" AS ENUM (
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'WON',
  'LOST'
);

CREATE TYPE "LeadSource" AS ENUM (
  'NO_ACCESS_SCREEN',
  'MARKETING_SITE',
  'OTHER'
);

CREATE TABLE "leads" (
  "id"             TEXT NOT NULL,
  "firstName"      TEXT NOT NULL,
  "lastName"       TEXT NOT NULL,
  "email"          TEXT NOT NULL,
  "phone"          TEXT,
  "country"        TEXT,
  "companyName"    TEXT,
  "numberOfLocations" TEXT,
  "hearAboutUs"    TEXT,
  "message"        TEXT,
  "source"         "LeadSource" NOT NULL DEFAULT 'NO_ACCESS_SCREEN',
  "status"         "LeadStatus" NOT NULL DEFAULT 'NEW',
  "submittedByUserId" TEXT,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leads_status_idx"    ON "leads"("status");
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");
CREATE INDEX "leads_email_idx"     ON "leads"("email");

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_submittedByUserId_fkey"
  FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id")
  ON DELETE SET NULL;
