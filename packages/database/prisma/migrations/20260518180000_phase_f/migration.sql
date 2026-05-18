-- ─────────────────────────────────────────────────────────────────────────────
-- OrderHub Phase F Migration
-- Commerce, Payments, Inventory, Notifications, White-label, Billing, Security,
-- Analytics, Mobile, Marketplace Registry
-- ─────────────────────────────────────────────────────────────────────────────

-- ── New Enums ────────────────────────────────────────────────────────────────

CREATE TYPE "PaymentRecordStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED'
);

CREATE TYPE "PaymentMethodType" AS ENUM (
  'CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'CASH', 'VOUCHER', 'BANK_TRANSFER', 'CRYPTO'
);

CREATE TYPE "RefundStatus" AS ENUM (
  'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);

CREATE TYPE "LedgerEntryType" AS ENUM (
  'PAYMENT', 'REFUND', 'PAYOUT', 'PLATFORM_FEE', 'PROCESSING_FEE', 'ADJUSTMENT', 'TIP'
);

CREATE TYPE "PayoutStatus" AS ENUM (
  'PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELLED'
);

CREATE TYPE "StockMovementType" AS ENUM (
  'PURCHASE', 'SALE_DEDUCTION', 'WASTE', 'ADJUSTMENT',
  'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN', 'COUNT_CORRECTION'
);

CREATE TYPE "PurchaseOrderStatus" AS ENUM (
  'DRAFT', 'SUBMITTED', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'
);

CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

CREATE TYPE "NotificationType" AS ENUM (
  'ORDER_NEW', 'ORDER_UPDATED', 'ORDER_CANCELLED', 'DRIVER_ASSIGNED',
  'DELIVERY_UPDATE', 'PRINT_FAILURE', 'INTEGRATION_FAILURE',
  'LOW_STOCK', 'MARKETING', 'SYSTEM'
);

CREATE TYPE "NotificationChannel" AS ENUM (
  'FCM', 'APNS', 'WEB_PUSH', 'SMS', 'EMAIL', 'IN_APP'
);

CREATE TYPE "DomainStatus" AS ENUM (
  'PENDING', 'VERIFYING', 'VERIFIED', 'ACTIVE', 'FAILED'
);

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'PAUSED', 'INCOMPLETE'
);

CREATE TYPE "InvoiceStatus" AS ENUM (
  'DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE'
);

CREATE TYPE "ProviderCategory" AS ENUM (
  'DELIVERY_MARKETPLACE', 'OWN_DELIVERY', 'POS',
  'DISPATCH', 'ACCOUNTING', 'MARKETING', 'PAYMENT'
);

-- Extend existing enums
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'TALABAT';
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'DOORDASH';
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'GRUBHUB';
ALTER TYPE "IntegrationPlatform" ADD VALUE IF NOT EXISTS 'CAREEM';

ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'TALABAT';
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'DOORDASH';
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'GRUBHUB';
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'CAREEM';

ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'TALABAT';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'DOORDASH';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'GRUBHUB';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'CAREEM';

-- ── Payment & Financial ───────────────────────────────────────────────────────

CREATE TABLE "stripe_connect_accounts" (
    "id"                 TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"           TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    "locationId"         TEXT,
    "stripeAccountId"    TEXT NOT NULL UNIQUE,
    "accountType"        TEXT NOT NULL DEFAULT 'EXPRESS',
    "chargesEnabled"     BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled"     BOOLEAN NOT NULL DEFAULT false,
    "defaultCurrency"    TEXT NOT NULL DEFAULT 'gbp',
    "country"            TEXT NOT NULL DEFAULT 'GB',
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "metadata"           JSONB NOT NULL DEFAULT '{}',
    "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "stripe_connect_accounts_tenantId_idx" ON "stripe_connect_accounts"("tenantId");

CREATE TABLE "payments" (
    "id"                     TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"               TEXT NOT NULL,
    "orderId"                TEXT NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
    "stripeConnectAccountId" TEXT REFERENCES "stripe_connect_accounts"("id") ON DELETE SET NULL,
    "stripePaymentIntentId"  TEXT UNIQUE,
    "stripeChargeId"         TEXT UNIQUE,
    "amount"                 DECIMAL(10,2) NOT NULL,
    "currency"               TEXT NOT NULL DEFAULT 'gbp',
    "status"                 "PaymentRecordStatus" NOT NULL,
    "method"                 "PaymentMethodType" NOT NULL,
    "tipAmount"              DECIMAL(10,2) NOT NULL DEFAULT 0,
    "platformFee"            DECIMAL(10,2) NOT NULL DEFAULT 0,
    "processingFee"          DECIMAL(10,2) NOT NULL DEFAULT 0,
    "netAmount"              DECIMAL(10,2) NOT NULL,
    "metadata"               JSONB NOT NULL DEFAULT '{}',
    "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "payments_tenantId_createdAt_idx" ON "payments"("tenantId", "createdAt" DESC);
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

CREATE TABLE "payment_methods" (
    "id"                    TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "customerId"            TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
    "stripePaymentMethodId" TEXT NOT NULL UNIQUE,
    "type"                  "PaymentMethodType" NOT NULL,
    "last4"                 TEXT,
    "brand"                 TEXT,
    "expMonth"              INT,
    "expYear"               INT,
    "isDefault"             BOOLEAN NOT NULL DEFAULT false,
    "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "payment_methods_customerId_idx" ON "payment_methods"("customerId");

CREATE TABLE "refunds" (
    "id"             TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"       TEXT NOT NULL,
    "paymentId"      TEXT NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT,
    "stripeRefundId" TEXT UNIQUE,
    "amount"         DECIMAL(10,2) NOT NULL,
    "reason"         TEXT,
    "status"         "RefundStatus" NOT NULL,
    "isPartial"      BOOLEAN NOT NULL DEFAULT false,
    "processedBy"    TEXT,
    "note"           TEXT,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "refunds_tenantId_idx" ON "refunds"("tenantId");
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

CREATE TABLE "ledger_entries" (
    "id"          TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"    TEXT NOT NULL,
    "paymentId"   TEXT REFERENCES "payments"("id") ON DELETE SET NULL,
    "refundId"    TEXT REFERENCES "refunds"("id") ON DELETE SET NULL,
    "type"        "LedgerEntryType" NOT NULL,
    "amount"      DECIMAL(10,2) NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'gbp',
    "description" TEXT NOT NULL,
    "reference"   TEXT,
    "metadata"    JSONB NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "ledger_entries_tenantId_createdAt_idx" ON "ledger_entries"("tenantId", "createdAt" DESC);
CREATE INDEX "ledger_entries_paymentId_idx" ON "ledger_entries"("paymentId");

CREATE TABLE "payouts" (
    "id"               TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"         TEXT NOT NULL,
    "connectAccountId" TEXT REFERENCES "stripe_connect_accounts"("id") ON DELETE SET NULL,
    "stripePayoutId"   TEXT NOT NULL UNIQUE,
    "amount"           DECIMAL(10,2) NOT NULL,
    "currency"         TEXT NOT NULL DEFAULT 'gbp',
    "status"           "PayoutStatus" NOT NULL,
    "arrivalDate"      TIMESTAMPTZ,
    "description"      TEXT,
    "metadata"         JSONB NOT NULL DEFAULT '{}',
    "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "payouts_tenantId_idx" ON "payouts"("tenantId");

-- ── Inventory & Stock ─────────────────────────────────────────────────────────

CREATE TABLE "suppliers" (
    "id"        TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    "name"      TEXT NOT NULL,
    "email"     TEXT,
    "phone"     TEXT,
    "address"   JSONB,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "metadata"  JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "suppliers_tenantId_idx" ON "suppliers"("tenantId");

CREATE TABLE "ingredients" (
    "id"            TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"      TEXT NOT NULL,
    "locationId"    TEXT NOT NULL,
    "supplierId"    TEXT REFERENCES "suppliers"("id") ON DELETE SET NULL,
    "name"          TEXT NOT NULL,
    "unit"          TEXT NOT NULL,
    "costPerUnit"   DECIMAL(10,4) NOT NULL,
    "lowStockAlert" INT,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "metadata"      JSONB NOT NULL DEFAULT '{}',
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "ingredients_tenantId_idx" ON "ingredients"("tenantId");
CREATE INDEX "ingredients_tenantId_locationId_idx" ON "ingredients"("tenantId", "locationId");

CREATE TABLE "stock_levels" (
    "id"           TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "ingredientId" TEXT NOT NULL REFERENCES "ingredients"("id") ON DELETE CASCADE,
    "locationId"   TEXT NOT NULL,
    "quantity"     DECIMAL(10,3) NOT NULL,
    "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE ("ingredientId", "locationId")
);
CREATE INDEX "stock_levels_locationId_idx" ON "stock_levels"("locationId");

CREATE TABLE "recipes" (
    "id"         TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"   TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL UNIQUE REFERENCES "menu_items"("id") ON DELETE CASCADE,
    "yields"     DECIMAL(6,2) NOT NULL DEFAULT 1,
    "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "recipes_tenantId_idx" ON "recipes"("tenantId");

CREATE TABLE "recipe_ingredients" (
    "id"           TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "recipeId"     TEXT NOT NULL REFERENCES "recipes"("id") ON DELETE CASCADE,
    "ingredientId" TEXT NOT NULL REFERENCES "ingredients"("id") ON DELETE RESTRICT,
    "quantity"     DECIMAL(10,3) NOT NULL,
    UNIQUE ("recipeId", "ingredientId")
);

CREATE TABLE "stock_movements" (
    "id"              TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"        TEXT NOT NULL,
    "locationId"      TEXT NOT NULL,
    "ingredientId"    TEXT NOT NULL REFERENCES "ingredients"("id") ON DELETE RESTRICT,
    "type"            "StockMovementType" NOT NULL,
    "quantity"        DECIMAL(10,3) NOT NULL,
    "reason"          TEXT,
    "orderId"         TEXT,
    "purchaseOrderId" TEXT,
    "recordedBy"      TEXT,
    "metadata"        JSONB NOT NULL DEFAULT '{}',
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "stock_movements_tenantId_locationId_createdAt_idx"
    ON "stock_movements"("tenantId", "locationId", "createdAt" DESC);
CREATE INDEX "stock_movements_ingredientId_createdAt_idx"
    ON "stock_movements"("ingredientId", "createdAt" DESC);

CREATE TABLE "purchase_orders" (
    "id"         TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"   TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
    "status"     "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderedAt"  TIMESTAMPTZ,
    "expectedAt" TIMESTAMPTZ,
    "receivedAt" TIMESTAMPTZ,
    "totalCost"  DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes"      TEXT,
    "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "purchase_orders_tenantId_locationId_idx" ON "purchase_orders"("tenantId", "locationId");
CREATE INDEX "purchase_orders_supplierId_idx" ON "purchase_orders"("supplierId");

CREATE TABLE "purchase_order_lines" (
    "id"              TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "purchaseOrderId" TEXT NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
    "ingredientId"    TEXT NOT NULL REFERENCES "ingredients"("id") ON DELETE RESTRICT,
    "quantity"        DECIMAL(10,3) NOT NULL,
    "unitCost"        DECIMAL(10,4) NOT NULL,
    "totalCost"       DECIMAL(10,2) NOT NULL,
    "receivedQty"     DECIMAL(10,3)
);
CREATE INDEX "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines"("purchaseOrderId");
CREATE INDEX "purchase_order_lines_ingredientId_idx" ON "purchase_order_lines"("ingredientId");

-- ── Push Notifications ────────────────────────────────────────────────────────

CREATE TABLE "device_tokens" (
    "id"        TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId"    TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "tenantId"  TEXT NOT NULL,
    "token"     TEXT NOT NULL UNIQUE,
    "platform"  "DevicePlatform" NOT NULL,
    "deviceId"  TEXT,
    "appId"     TEXT,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "device_tokens_userId_idx" ON "device_tokens"("userId");
CREATE INDEX "device_tokens_tenantId_idx" ON "device_tokens"("tenantId");

CREATE TABLE "notification_logs" (
    "id"        TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"  TEXT NOT NULL,
    "userId"    TEXT,
    "type"      "NotificationType" NOT NULL,
    "channel"   "NotificationChannel" NOT NULL,
    "title"     TEXT NOT NULL,
    "body"      TEXT NOT NULL,
    "data"      JSONB NOT NULL DEFAULT '{}',
    "status"    TEXT NOT NULL DEFAULT 'SENT',
    "errorMsg"  TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "notification_logs_tenantId_createdAt_idx" ON "notification_logs"("tenantId", "createdAt" DESC);
CREATE INDEX "notification_logs_userId_idx" ON "notification_logs"("userId");

-- ── White-label Branding ──────────────────────────────────────────────────────

CREATE TABLE "tenant_branding" (
    "id"              TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"        TEXT NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
    "logoUrl"         TEXT,
    "faviconUrl"      TEXT,
    "primaryColor"    TEXT NOT NULL DEFAULT '#f97316',
    "secondaryColor"  TEXT NOT NULL DEFAULT '#1a1a2e',
    "accentColor"     TEXT NOT NULL DEFAULT '#fb923c',
    "fontFamily"      TEXT NOT NULL DEFAULT 'Inter',
    "customCss"       TEXT,
    "appName"         TEXT,
    "metaTitle"       TEXT,
    "metaDescription" TEXT,
    "emailFromName"   TEXT,
    "emailFromAddr"   TEXT,
    "emailFooterHtml" TEXT,
    "senderSmsName"   TEXT,
    "socialLinks"     JSONB NOT NULL DEFAULT '{}',
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "custom_domains" (
    "id"         TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"   TEXT NOT NULL,
    "brandingId" TEXT NOT NULL REFERENCES "tenant_branding"("id") ON DELETE CASCADE,
    "domain"     TEXT NOT NULL UNIQUE,
    "status"     "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMPTZ,
    "sslAt"      TIMESTAMPTZ,
    "txtRecord"  TEXT,
    "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "custom_domains_tenantId_idx" ON "custom_domains"("tenantId");

-- ── Billing & Subscriptions ───────────────────────────────────────────────────

CREATE TABLE "subscription_plans" (
    "id"               TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "name"             TEXT NOT NULL UNIQUE,
    "displayName"      TEXT NOT NULL,
    "stripePriceId"    TEXT UNIQUE,
    "pricePerMonth"    DECIMAL(10,2) NOT NULL,
    "pricePerLocation" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "maxLocations"     INT,
    "maxUsers"         INT,
    "features"         JSONB NOT NULL DEFAULT '[]',
    "isActive"         BOOLEAN NOT NULL DEFAULT true,
    "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default plans
INSERT INTO "subscription_plans" ("id", "name", "displayName", "pricePerMonth", "pricePerLocation", "maxLocations", "maxUsers", "features")
VALUES
  ('plan_starter', 'STARTER', 'Starter', 49.00, 0, 1, 5,
   '["orders","menu","integrations","kds","printers"]'),
  ('plan_professional', 'PROFESSIONAL', 'Professional', 149.00, 29.00, 10, 25,
   '["orders","menu","integrations","kds","printers","store_ops","customers","drivers","analytics","inventory"]'),
  ('plan_enterprise', 'ENTERPRISE', 'Enterprise', 499.00, 49.00, NULL, NULL,
   '["orders","menu","integrations","kds","printers","store_ops","customers","drivers","analytics","inventory","white_label","api_access","sso","advanced_analytics"]');

CREATE TABLE "tenant_subscriptions" (
    "id"                 TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"           TEXT NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
    "planId"             TEXT NOT NULL REFERENCES "subscription_plans"("id") ON DELETE RESTRICT,
    "stripeSubId"        TEXT UNIQUE,
    "stripeCustomerId"   TEXT,
    "status"             "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMPTZ NOT NULL,
    "currentPeriodEnd"   TIMESTAMPTZ NOT NULL,
    "cancelAtPeriodEnd"  BOOLEAN NOT NULL DEFAULT false,
    "trialEndsAt"        TIMESTAMPTZ,
    "locationCount"      INT NOT NULL DEFAULT 1,
    "metadata"           JSONB NOT NULL DEFAULT '{}',
    "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "tenant_subscriptions_tenantId_idx" ON "tenant_subscriptions"("tenantId");

CREATE TABLE "invoices" (
    "id"              TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"        TEXT NOT NULL,
    "subscriptionId"  TEXT NOT NULL REFERENCES "tenant_subscriptions"("id") ON DELETE RESTRICT,
    "stripeInvoiceId" TEXT UNIQUE,
    "number"          TEXT NOT NULL UNIQUE,
    "status"          "InvoiceStatus" NOT NULL,
    "amountDue"       DECIMAL(10,2) NOT NULL,
    "amountPaid"      DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency"        TEXT NOT NULL DEFAULT 'gbp',
    "dueDate"         TIMESTAMPTZ,
    "paidAt"          TIMESTAMPTZ,
    "pdfUrl"          TEXT,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "invoices_tenantId_idx" ON "invoices"("tenantId");
CREATE INDEX "invoices_subscriptionId_idx" ON "invoices"("subscriptionId");

CREATE TABLE "invoice_line_items" (
    "id"          TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "invoiceId"   TEXT NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
    "description" TEXT NOT NULL,
    "quantity"    INT NOT NULL DEFAULT 1,
    "unitAmount"  DECIMAL(10,2) NOT NULL,
    "amount"      DECIMAL(10,2) NOT NULL
);
CREATE INDEX "invoice_line_items_invoiceId_idx" ON "invoice_line_items"("invoiceId");

-- ── Enterprise Security ────────────────────────────────────────────────────────

CREATE TABLE "mfa_configs" (
    "id"          TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId"      TEXT NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
    "secret"      TEXT NOT NULL,
    "isEnabled"   BOOLEAN NOT NULL DEFAULT false,
    "backupCodes" JSONB NOT NULL DEFAULT '[]',
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "ip_allowlists" (
    "id"        TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    "cidr"      TEXT NOT NULL,
    "label"     TEXT,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "ip_allowlists_tenantId_isActive_idx" ON "ip_allowlists"("tenantId", "isActive");

CREATE TABLE "device_sessions" (
    "id"           TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId"       TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "tenantId"     TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL UNIQUE,
    "deviceName"   TEXT,
    "deviceType"   TEXT,
    "appVersion"   TEXT,
    "ipAddress"    TEXT,
    "userAgent"    TEXT,
    "lastSeenAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt"    TIMESTAMPTZ NOT NULL,
    "revokedAt"    TIMESTAMPTZ,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "device_sessions_userId_idx" ON "device_sessions"("userId");
CREATE INDEX "device_sessions_tenantId_lastSeenAt_idx" ON "device_sessions"("tenantId", "lastSeenAt" DESC);

-- ── Advanced Analytics ─────────────────────────────────────────────────────────

CREATE TABLE "daily_sales_snapshots" (
    "id"              TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"        TEXT NOT NULL,
    "locationId"      TEXT NOT NULL,
    "date"            DATE NOT NULL,
    "platform"        TEXT,
    "totalRevenue"    DECIMAL(12,2) NOT NULL,
    "totalOrders"     INT NOT NULL,
    "avgOrderValue"   DECIMAL(10,2) NOT NULL,
    "newCustomers"    INT NOT NULL DEFAULT 0,
    "repeatCustomers" INT NOT NULL DEFAULT 0,
    "cancelledOrders" INT NOT NULL DEFAULT 0,
    "avgPrepTimeMin"  DECIMAL(6,2) NOT NULL DEFAULT 0,
    "metadata"        JSONB NOT NULL DEFAULT '{}',
    UNIQUE ("tenantId", "locationId", "date", "platform")
);
CREATE INDEX "daily_sales_snapshots_tenantId_date_idx" ON "daily_sales_snapshots"("tenantId", "date" DESC);
CREATE INDEX "daily_sales_snapshots_locationId_date_idx" ON "daily_sales_snapshots"("locationId", "date" DESC);

CREATE TABLE "item_performance_snapshots" (
    "id"           TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"     TEXT NOT NULL,
    "menuItemId"   TEXT NOT NULL,
    "locationId"   TEXT NOT NULL,
    "date"         DATE NOT NULL,
    "totalSold"    INT NOT NULL,
    "totalRevenue" DECIMAL(12,2) NOT NULL,
    "cancelledQty" INT NOT NULL DEFAULT 0,
    UNIQUE ("tenantId", "menuItemId", "locationId", "date")
);
CREATE INDEX "item_performance_snapshots_tenantId_date_idx"
    ON "item_performance_snapshots"("tenantId", "date" DESC);
CREATE INDEX "item_performance_snapshots_menuItemId_date_idx"
    ON "item_performance_snapshots"("menuItemId", "date" DESC);

-- ── Provider Registry ─────────────────────────────────────────────────────────

CREATE TABLE "provider_definitions" (
    "id"           TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "key"          TEXT NOT NULL UNIQUE,
    "name"         TEXT NOT NULL,
    "category"     "ProviderCategory" NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "webhookPath"  TEXT,
    "logoUrl"      TEXT,
    "docsUrl"      TEXT,
    "isEnabled"    BOOLEAN NOT NULL DEFAULT true,
    "isBeta"       BOOLEAN NOT NULL DEFAULT false,
    "metadata"     JSONB NOT NULL DEFAULT '{}',
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed provider registry
INSERT INTO "provider_definitions" ("id", "key", "name", "category", "capabilities", "webhookPath", "isBeta") VALUES
  ('prov_ubereats',   'UBER_EATS',   'Uber Eats',   'DELIVERY_MARKETPLACE', '["order_sync","menu_push","availability"]', '/webhooks/uber-eats',   false),
  ('prov_deliveroo',  'DELIVEROO',   'Deliveroo',   'DELIVERY_MARKETPLACE', '["order_sync","menu_push","availability"]', '/webhooks/deliveroo',   false),
  ('prov_justeat',    'JUST_EAT',    'Just Eat',    'DELIVERY_MARKETPLACE', '["order_sync","menu_push","availability"]', '/webhooks/just-eat',    false),
  ('prov_hubrise',    'HUBRISE',     'HubRise',     'DELIVERY_MARKETPLACE', '["order_sync","menu_push","availability","accounting"]', '/webhooks/hubrise', false),
  ('prov_talabat',    'TALABAT',     'Talabat',     'DELIVERY_MARKETPLACE', '["order_sync","menu_push"]', '/webhooks/talabat', true),
  ('prov_doordash',   'DOORDASH',    'DoorDash',    'DELIVERY_MARKETPLACE', '["order_sync","menu_push"]', '/webhooks/doordash', true),
  ('prov_grubhub',    'GRUBHUB',     'Grubhub',     'DELIVERY_MARKETPLACE', '["order_sync"]', '/webhooks/grubhub', true),
  ('prov_careem',     'CAREEM',      'Careem Now',  'DELIVERY_MARKETPLACE', '["order_sync"]', '/webhooks/careem', true),
  ('prov_stuart',     'STUART',      'Stuart',      'OWN_DELIVERY',        '["dispatch"]', NULL, true),
  ('prov_uberdirect', 'UBER_DIRECT', 'Uber Direct', 'OWN_DELIVERY',        '["dispatch"]', NULL, true),
  ('prov_stripe',     'STRIPE',      'Stripe',      'PAYMENT',             '["payment","refund","payout","connect"]', '/webhooks/stripe', false),
  ('prov_xero',       'XERO',        'Xero',        'ACCOUNTING',          '["invoice_sync","reconciliation"]', '/webhooks/xero', true);

CREATE TABLE "webhook_routes" (
    "id"          TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "tenantId"    TEXT NOT NULL,
    "locationId"  TEXT,
    "providerKey" TEXT NOT NULL,
    "pathPattern" TEXT NOT NULL,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "metadata"    JSONB NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "webhook_routes_tenantId_idx" ON "webhook_routes"("tenantId");
CREATE INDEX "webhook_routes_providerKey_idx" ON "webhook_routes"("providerKey");

-- ── Mobile Architecture ───────────────────────────────────────────────────────

CREATE TABLE "mobile_sessions" (
    "id"          TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId"      TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "appId"       TEXT NOT NULL,
    "deviceId"    TEXT NOT NULL,
    "deviceModel" TEXT,
    "osVersion"   TEXT,
    "appVersion"  TEXT NOT NULL,
    "fcmToken"    TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE ("userId", "deviceId", "appId")
);
CREATE INDEX "mobile_sessions_tenantId_idx" ON "mobile_sessions"("tenantId");
CREATE INDEX "mobile_sessions_userId_idx" ON "mobile_sessions"("userId");

CREATE TABLE "web_push_subscriptions" (
    "id"        TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId"    TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "endpoint"  TEXT NOT NULL UNIQUE,
    "p256dh"    TEXT NOT NULL,
    "auth"      TEXT NOT NULL,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "web_push_subscriptions_userId_idx" ON "web_push_subscriptions"("userId");
CREATE INDEX "web_push_subscriptions_tenantId_idx" ON "web_push_subscriptions"("tenantId");
