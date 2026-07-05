-- Phase LG — operator-facing activity feed (dashboard Logs page).
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "brandId" TEXT,
    "category" TEXT NOT NULL,
    "channel" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activity_logs_tenantId_createdAt_idx" ON "activity_logs"("tenantId", "createdAt" DESC);
CREATE INDEX "activity_logs_tenantId_category_createdAt_idx" ON "activity_logs"("tenantId", "category", "createdAt" DESC);
CREATE INDEX "activity_logs_tenantId_locationId_createdAt_idx" ON "activity_logs"("tenantId", "locationId", "createdAt" DESC);
