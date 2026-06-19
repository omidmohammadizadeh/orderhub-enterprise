-- Phase AW-30 — per-location SaaS subscriptions billed by the platform.
-- Distinct from tenant_subscriptions which is tenant-wide. Card update,
-- invoice list, and PDF download flow through the Stripe Customer Portal;
-- this table just mirrors the bits we render in our own UI.

CREATE TABLE "merchant_subscriptions" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "locationId"           TEXT NOT NULL,
  "stripeCustomerId"     TEXT,
  "stripeSubscriptionId" TEXT,
  "stripePriceId"        TEXT,
  "stripeCheckoutId"     TEXT,
  "monthlyAmountPence"   INTEGER NOT NULL,
  "currency"             TEXT NOT NULL DEFAULT 'gbp',
  "status"               TEXT NOT NULL DEFAULT 'incomplete',
  "currentPeriodStart"   TIMESTAMP(3),
  "currentPeriodEnd"     TIMESTAMP(3),
  "cancelAtPeriodEnd"    BOOLEAN NOT NULL DEFAULT false,
  "trialEndsAt"          TIMESTAMP(3),
  "defaultPaymentBrand"  TEXT,
  "defaultPaymentLast4"  TEXT,
  "lastInvoiceStatus"    TEXT,
  "lastFailureMessage"   TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_subscriptions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_subscriptions_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "merchant_subscriptions_locationId_key"
  ON "merchant_subscriptions"("locationId");
CREATE UNIQUE INDEX "merchant_subscriptions_stripeCustomerId_key"
  ON "merchant_subscriptions"("stripeCustomerId");
CREATE UNIQUE INDEX "merchant_subscriptions_stripeSubscriptionId_key"
  ON "merchant_subscriptions"("stripeSubscriptionId");
CREATE INDEX "merchant_subscriptions_tenantId_idx"
  ON "merchant_subscriptions"("tenantId");
CREATE INDEX "merchant_subscriptions_status_idx"
  ON "merchant_subscriptions"("status");
