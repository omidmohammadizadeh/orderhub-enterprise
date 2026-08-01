-- Customer reviews of completed orders. Additive and idempotent: this file is
-- applied on Render boot, so it must be safe to re-run.
CREATE TABLE IF NOT EXISTS "reviews" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "orderId"      TEXT NOT NULL,
    "locationId"   TEXT NOT NULL,
    "brandId"      TEXT,
    "customerId"   TEXT,
    "customerName" TEXT,
    "rating"       INTEGER NOT NULL,
    "comment"      TEXT,
    "status"       TEXT NOT NULL DEFAULT 'PUBLISHED',
    "reply"        TEXT,
    "repliedAt"    TIMESTAMP(3),
    "repliedBy"    TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- One review per order.
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_orderId_key" ON "reviews"("orderId");
CREATE INDEX IF NOT EXISTS "reviews_tenantId_createdAt_idx" ON "reviews"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "reviews_locationId_status_idx" ON "reviews"("locationId", "status");
CREATE INDEX IF NOT EXISTS "reviews_brandId_status_idx" ON "reviews"("brandId", "status");
