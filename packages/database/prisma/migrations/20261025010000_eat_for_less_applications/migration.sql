-- Eat For Less: partner applications, and the food hygiene link on a listing.

CREATE TYPE "EflApplicationStatus" AS ENUM ('NEW', 'WAITING_INFO', 'APPROVED', 'DECLINED');

CREATE TABLE "efl_applications" (
    "id" TEXT NOT NULL,
    "status" "EflApplicationStatus" NOT NULL DEFAULT 'NEW',
    "businessName" TEXT NOT NULL,
    "companyNumber" TEXT,
    "cuisine" TEXT,
    "addressLine1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "menuUrl" TEXT,
    "hygieneUrl" TEXT,
    "idDocPath" TEXT,
    "bankDocPath" TEXT,
    "checks" JSONB NOT NULL DEFAULT '{}',
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "efl_applications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "efl_applications_status_createdAt_idx" ON "efl_applications"("status", "createdAt");

ALTER TABLE "efl_listings" ADD COLUMN "fsaEstablishmentId" TEXT;
ALTER TABLE "efl_listings" ADD COLUMN "hygieneRating" TEXT;
ALTER TABLE "efl_listings" ADD COLUMN "hygieneCheckedAt" TIMESTAMP(3);
