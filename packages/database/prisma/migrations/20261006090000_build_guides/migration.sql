-- "How to build" kitchen build charts, one per brand + product name.
CREATE TABLE "build_guides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "packNote" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "build_guides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "build_guides_brandId_nameKey_key" ON "build_guides"("brandId", "nameKey");
CREATE INDEX "build_guides_tenantId_nameKey_idx" ON "build_guides"("tenantId", "nameKey");

ALTER TABLE "build_guides" ADD CONSTRAINT "build_guides_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
