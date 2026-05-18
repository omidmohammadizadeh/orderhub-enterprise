-- Phase E: Restaurant Operations Layer
-- Adds: store ops controls, normalized modifiers, item variants, menu versioning,
--       customer CRM, promo codes, driver/dispatch foundation, print templates

-- ── MenuItem enhancements ──────────────────────────────────────────────────────
-- Drop legacy JSON modifier column — replaced by normalized modifier_groups tables
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "modifierGroups";
ALTER TABLE "menu_items" ADD COLUMN "dietaryTags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "menu_items" ADD COLUMN "prepTime" INTEGER;
ALTER TABLE "menu_items" ADD COLUMN "inventoryCount" INTEGER;
ALTER TABLE "menu_items" ADD COLUMN "isInventoryTracked" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "menu_items" ADD COLUMN "platformPricingOverrides" JSONB NOT NULL DEFAULT '{}';
-- modifierGroups Json column kept for backward compat during migration period;
-- new code uses normalized modifier_groups tables
-- DROP COLUMN "modifierGroups" handled by apps once migration is complete

-- ── MenuCategory enhancements ─────────────────────────────────────────────────
ALTER TABLE "menu_categories" ADD COLUMN "description" TEXT;
ALTER TABLE "menu_categories" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "menu_categories" ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT TRUE;

-- ── MenuItemOnCategory enhancements ──────────────────────────────────────────
ALTER TABLE "menu_items_on_categories" ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Location — store operations fields ────────────────────────────────────────
ALTER TABLE "locations" ADD COLUMN "isOpen" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "locations" ADD COLUMN "isPaused" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "locations" ADD COLUMN "pauseUntil" TIMESTAMP(3);
ALTER TABLE "locations" ADD COLUMN "busyMode" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "locations" ADD COLUMN "currentPrepTime" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "locations" ADD COLUMN "throttleLimit" INTEGER;
ALTER TABLE "locations" ADD COLUMN "storeStatusNote" TEXT;

-- ── Printer enhancements ──────────────────────────────────────────────────────
ALTER TABLE "printers" ADD COLUMN "failoverPrinterId" TEXT;
ALTER TABLE "printers" ADD COLUMN "autoPrintRules" JSONB NOT NULL DEFAULT '[]';

-- ── Order enhancements ────────────────────────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN "customerId" TEXT;
ALTER TABLE "orders" ADD COLUMN "serviceCharge" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "promoCode" TEXT;
ALTER TABLE "orders" ADD COLUMN "promoDiscount" DECIMAL(10,2);
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- ── Normalized modifier groups ────────────────────────────────────────────────
CREATE TABLE "modifier_groups" (
    "id"            TEXT NOT NULL,
    "brandId"       TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "description"   TEXT,
    "minSelections" INTEGER NOT NULL DEFAULT 0,
    "maxSelections" INTEGER,
    "isRequired"    BOOLEAN NOT NULL DEFAULT FALSE,
    "sortOrder"     INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "modifier_groups_brandId_fkey" FOREIGN KEY ("brandId")
        REFERENCES "brands"("id") ON DELETE CASCADE
);
CREATE INDEX "modifier_groups_brandId_idx" ON "modifier_groups"("brandId");

CREATE TABLE "modifier_options" (
    "id"              TEXT NOT NULL,
    "groupId"         TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT,
    "priceAdjustment" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "imageUrl"        TEXT,
    "allergens"       TEXT[] NOT NULL DEFAULT '{}',
    "isDefault"       BOOLEAN NOT NULL DEFAULT FALSE,
    "isAvailable"     BOOLEAN NOT NULL DEFAULT TRUE,
    "sortOrder"       INTEGER NOT NULL DEFAULT 0,
    "nestedGroupId"   TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "modifier_options_groupId_fkey" FOREIGN KEY ("groupId")
        REFERENCES "modifier_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "modifier_options_nestedGroupId_fkey" FOREIGN KEY ("nestedGroupId")
        REFERENCES "modifier_groups"("id") ON DELETE SET NULL
);
CREATE INDEX "modifier_options_groupId_idx" ON "modifier_options"("groupId");

CREATE TABLE "modifier_groups_on_items" (
    "itemId"    TEXT NOT NULL,
    "groupId"   TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "modifier_groups_on_items_pkey" PRIMARY KEY ("itemId", "groupId"),
    CONSTRAINT "modifier_groups_on_items_itemId_fkey" FOREIGN KEY ("itemId")
        REFERENCES "menu_items"("id") ON DELETE CASCADE,
    CONSTRAINT "modifier_groups_on_items_groupId_fkey" FOREIGN KEY ("groupId")
        REFERENCES "modifier_groups"("id") ON DELETE CASCADE
);
CREATE INDEX "modifier_groups_on_items_itemId_idx" ON "modifier_groups_on_items"("itemId");

-- ── Menu item variants ────────────────────────────────────────────────────────
CREATE TABLE "menu_item_variants" (
    "id"          TEXT NOT NULL,
    "itemId"      TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "sku"         TEXT,
    "price"       DECIMAL(10,2) NOT NULL,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "isAvailable" BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "menu_item_variants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_item_variants_itemId_fkey" FOREIGN KEY ("itemId")
        REFERENCES "menu_items"("id") ON DELETE CASCADE
);
CREATE INDEX "menu_item_variants_itemId_idx" ON "menu_item_variants"("itemId");

-- ── Menu versioning ───────────────────────────────────────────────────────────
CREATE TABLE "menu_versions" (
    "id"        TEXT NOT NULL,
    "menuId"    TEXT NOT NULL,
    "version"   INTEGER NOT NULL,
    "snapshot"  JSONB NOT NULL,
    "label"     TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "menu_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_versions_menuId_version_key" UNIQUE ("menuId", "version"),
    CONSTRAINT "menu_versions_menuId_fkey" FOREIGN KEY ("menuId")
        REFERENCES "menus"("id") ON DELETE CASCADE
);
CREATE INDEX "menu_versions_menuId_idx" ON "menu_versions"("menuId");

-- ── Customer CRM ──────────────────────────────────────────────────────────────
CREATE TABLE "customers" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "email"            TEXT,
    "phone"            TEXT,
    "firstName"        TEXT,
    "lastName"         TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT FALSE,
    "isActive"         BOOLEAN NOT NULL DEFAULT TRUE,
    "tags"             TEXT[] NOT NULL DEFAULT '{}',
    "metadata"         JSONB NOT NULL DEFAULT '{}',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customers_tenantId_email_key" UNIQUE ("tenantId", "email"),
    CONSTRAINT "customers_tenantId_phone_key" UNIQUE ("tenantId", "phone"),
    CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "customers_tenantId_idx" ON "customers"("tenantId");
CREATE INDEX "customers_tenantId_email_idx" ON "customers"("tenantId", "email");

CREATE TABLE "customer_addresses" (
    "id"          TEXT NOT NULL,
    "customerId"  TEXT NOT NULL,
    "label"       TEXT,
    "line1"       TEXT NOT NULL,
    "line2"       TEXT,
    "city"        TEXT NOT NULL,
    "postcode"    TEXT NOT NULL,
    "country"     TEXT NOT NULL DEFAULT 'GB',
    "isDefault"   BOOLEAN NOT NULL DEFAULT FALSE,
    "coordinates" JSONB,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId")
        REFERENCES "customers"("id") ON DELETE CASCADE
);
CREATE INDEX "customer_addresses_customerId_idx" ON "customer_addresses"("customerId");

CREATE TABLE "loyalty_accounts" (
    "id"          TEXT NOT NULL,
    "customerId"  TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "points"      INTEGER NOT NULL DEFAULT 0,
    "tier"        TEXT NOT NULL DEFAULT 'BRONZE',
    "totalSpend"  DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "metadata"    JSONB NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_accounts_customerId_key" UNIQUE ("customerId"),
    CONSTRAINT "loyalty_accounts_customerId_fkey" FOREIGN KEY ("customerId")
        REFERENCES "customers"("id") ON DELETE CASCADE
);
CREATE INDEX "loyalty_accounts_tenantId_idx" ON "loyalty_accounts"("tenantId");

-- ── Promo codes ───────────────────────────────────────────────────────────────
CREATE TYPE "PromoCodeType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_DELIVERY');

CREATE TABLE "promo_codes" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL,
    "code"          TEXT NOT NULL,
    "description"   TEXT,
    "type"          "PromoCodeType" NOT NULL,
    "value"         DECIMAL(10,2) NOT NULL,
    "minOrderValue" DECIMAL(10,2),
    "maxUses"       INTEGER,
    "usedCount"     INTEGER NOT NULL DEFAULT 0,
    "startAt"       TIMESTAMP(3),
    "expiresAt"     TIMESTAMP(3),
    "isActive"      BOOLEAN NOT NULL DEFAULT TRUE,
    "locationIds"   TEXT[] NOT NULL DEFAULT '{}',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "promo_codes_tenantId_code_key" UNIQUE ("tenantId", "code"),
    CONSTRAINT "promo_codes_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "promo_codes_tenantId_idx" ON "promo_codes"("tenantId");
CREATE INDEX "promo_codes_tenantId_isActive_idx" ON "promo_codes"("tenantId", "isActive");

-- ── Driver / Dispatch ─────────────────────────────────────────────────────────
CREATE TYPE "DriverAssignmentStatus" AS ENUM (
    'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'CANCELLED'
);

CREATE TABLE "drivers" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "userId"      TEXT,
    "firstName"   TEXT NOT NULL,
    "lastName"    TEXT NOT NULL,
    "phone"       TEXT NOT NULL,
    "email"       TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
    "vehicleType" TEXT,
    "metadata"    JSONB NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "drivers_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "drivers_tenantId_idx" ON "drivers"("tenantId");
CREATE INDEX "drivers_tenantId_isActive_idx" ON "drivers"("tenantId", "isActive");

CREATE TABLE "driver_assignments" (
    "id"          TEXT NOT NULL,
    "orderId"     TEXT NOT NULL,
    "driverId"    TEXT NOT NULL,
    "status"      "DriverAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt"  TIMESTAMP(3),
    "pickedUpAt"  TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    CONSTRAINT "driver_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "driver_assignments_orderId_key" UNIQUE ("orderId"),
    CONSTRAINT "driver_assignments_orderId_fkey" FOREIGN KEY ("orderId")
        REFERENCES "orders"("id") ON DELETE CASCADE,
    CONSTRAINT "driver_assignments_driverId_fkey" FOREIGN KEY ("driverId")
        REFERENCES "drivers"("id") ON DELETE RESTRICT
);
CREATE INDEX "driver_assignments_driverId_idx" ON "driver_assignments"("driverId");
CREATE INDEX "driver_assignments_driverId_status_idx" ON "driver_assignments"("driverId", "status");

CREATE TABLE "delivery_tracking" (
    "id"           TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "lat"          DOUBLE PRECISION NOT NULL,
    "lng"          DOUBLE PRECISION NOT NULL,
    "accuracy"     DOUBLE PRECISION,
    "heading"      DOUBLE PRECISION,
    "speed"        DOUBLE PRECISION,
    "event"        TEXT,
    "recordedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_tracking_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delivery_tracking_assignmentId_fkey" FOREIGN KEY ("assignmentId")
        REFERENCES "driver_assignments"("id") ON DELETE CASCADE
);
CREATE INDEX "delivery_tracking_assignmentId_recordedAt_idx"
    ON "delivery_tracking"("assignmentId", "recordedAt" DESC);

-- ── Print templates ───────────────────────────────────────────────────────────
CREATE TABLE "print_templates" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT NOT NULL,
    "locationId" TEXT,
    "name"       TEXT NOT NULL,
    "type"       "PrintJobType" NOT NULL,
    "template"   JSONB NOT NULL,
    "isDefault"  BOOLEAN NOT NULL DEFAULT FALSE,
    "isActive"   BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "print_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "print_templates_tenantId_idx" ON "print_templates"("tenantId");
CREATE INDEX "print_templates_tenantId_type_idx" ON "print_templates"("tenantId", "type");

-- ── FK constraints added last (avoids ordering issues) ────────────────────────
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL;
