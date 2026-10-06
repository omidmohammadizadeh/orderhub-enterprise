-- Assembly charts: poster-style layer stacks per brand + product name.
CREATE TABLE "assembly_charts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "altTitle" TEXT,
    "heroImageUrl" TEXT,
    "layers" JSONB NOT NULL DEFAULT '[]',
    "footNote" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assembly_charts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "assembly_charts_brandId_nameKey_key" ON "assembly_charts"("brandId", "nameKey");
CREATE INDEX "assembly_charts_tenantId_nameKey_idx" ON "assembly_charts"("tenantId", "nameKey");
ALTER TABLE "assembly_charts" ADD CONSTRAINT "assembly_charts_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
