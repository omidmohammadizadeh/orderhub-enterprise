-- Table Tabs (dine-in) Phase 1

-- CreateTable
CREATE TABLE "tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seats" INTEGER,
    "area" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'FREE',
    "currentOrderId" TEXT,
    "openedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tables_tenantId_idx" ON "tables"("tenantId");

-- CreateIndex
CREATE INDEX "tables_locationId_idx" ON "tables"("locationId");

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: link a dine-in order to its table (the tab)
ALTER TABLE "orders" ADD COLUMN "tableId" TEXT;

-- CreateIndex
CREATE INDEX "orders_tableId_idx" ON "orders"("tableId");
