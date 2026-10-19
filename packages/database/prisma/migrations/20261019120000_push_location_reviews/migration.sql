-- One location's own review-push settings (overrides push_automations REVIEW_REQUEST).
CREATE TABLE "push_location_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "delayMinutes" INTEGER,
    "title" TEXT,
    "body" TEXT,
    "sendFromHour" INTEGER,
    "sendUntilHour" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_location_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_location_reviews_locationId_key" ON "push_location_reviews"("locationId");
CREATE INDEX "push_location_reviews_tenantId_idx" ON "push_location_reviews"("tenantId");
