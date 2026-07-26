-- Digital Signage — in-store menu boards on TV screens (per location).

CREATE TABLE "signage_displays" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "brandId" TEXT,
    "name" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orientation" TEXT NOT NULL DEFAULT 'landscape',
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signage_displays_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signage_displays_publicToken_key" ON "signage_displays"("publicToken");

CREATE INDEX "signage_displays_tenantId_idx" ON "signage_displays"("tenantId");

CREATE INDEX "signage_displays_locationId_idx" ON "signage_displays"("locationId");

ALTER TABLE "signage_displays"
    ADD CONSTRAINT "signage_displays_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "signage_displays"
    ADD CONSTRAINT "signage_displays_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
