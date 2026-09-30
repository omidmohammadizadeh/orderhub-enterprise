-- Retail R1 — take OrderHub from restaurants to shops (grocery, convenience,
-- clothing). Purely additive apart from one relaxed constraint:
--
--   * locations.businessType — RESTAURANT (default, so every existing row is
--     unchanged) | GROCERY | RETAIL. A preset for the till and setup screens.
--   * product_variants / product_stock_levels / product_stock_movements —
--     barcoded variants under a MenuItem, stock per location, and the
--     append-only ledger behind it (dedupeKey makes every stock event
--     idempotent).
--   * refund_lines + refunds.orderId/method — item-level returns.
--   * refunds.paymentId DROP NOT NULL — a walk-in cash sale has no Payment
--     row, so the cash handed back for its return has nothing to point at.

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RESTAURANT', 'GROCERY', 'RETAIL');

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "businessType" "BusinessType" NOT NULL DEFAULT 'RESTAURANT';

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "method" TEXT,
ADD COLUMN     "orderId" TEXT,
ALTER COLUMN "paymentId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "sku" TEXT,
    "barcode" TEXT,
    "price" DECIMAL(10,2),
    "costPrice" DECIMAL(10,2),
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "lowStockAt" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stock_levels" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "orderId" TEXT,
    "refundId" TEXT,
    "recordedBy" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_lines" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_variants_tenantId_barcode_idx" ON "product_variants"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "product_variants_menuItemId_idx" ON "product_variants"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_brandId_barcode_key" ON "product_variants"("brandId", "barcode");

-- CreateIndex
CREATE INDEX "product_stock_levels_locationId_idx" ON "product_stock_levels"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_levels_variantId_locationId_key" ON "product_stock_levels"("variantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_movements_dedupeKey_key" ON "product_stock_movements"("dedupeKey");

-- CreateIndex
CREATE INDEX "product_stock_movements_tenantId_locationId_createdAt_idx" ON "product_stock_movements"("tenantId", "locationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "product_stock_movements_variantId_createdAt_idx" ON "product_stock_movements"("variantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "product_stock_movements_orderId_idx" ON "product_stock_movements"("orderId");

-- CreateIndex
CREATE INDEX "refund_lines_refundId_idx" ON "refund_lines"("refundId");

-- CreateIndex
CREATE INDEX "refund_lines_orderItemId_idx" ON "refund_lines"("orderItemId");

-- CreateIndex
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_levels" ADD CONSTRAINT "product_stock_levels_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_levels" ADD CONSTRAINT "product_stock_levels_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

