-- Phase AP-AUTH — Customer-facing auth accounts for the public storefront.
--
-- Named "customer_accounts" not "customers" because a tenant-scoped
-- "customers" CRM table already exists (orders, addresses, loyalty per
-- restaurant). This new table is the AUTH IDENTITY — one row per real
-- human, not per "human-at-restaurant". A future migration can FK
-- Customer.accountId -> CustomerAccount.id if/when the storefront
-- wants to share order history across restaurants.

CREATE TABLE IF NOT EXISTS "customer_accounts" (
  "id"                     TEXT NOT NULL,
  "email"                  TEXT NOT NULL,
  "password"               TEXT,
  "firstName"              TEXT NOT NULL,
  "lastName"               TEXT NOT NULL,
  "phone"                  TEXT,
  "googleId"               TEXT,
  "avatarUrl"              TEXT,
  "isVerified"             BOOLEAN NOT NULL DEFAULT false,
  "emailVerificationToken" TEXT,
  "marketingOptIn"         BOOLEAN NOT NULL DEFAULT false,
  "lastLoginAt"            TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_accounts_email_key"    ON "customer_accounts"("email");
CREATE UNIQUE INDEX "customer_accounts_googleId_key" ON "customer_accounts"("googleId");
CREATE INDEX        "customer_accounts_email_idx"    ON "customer_accounts"("email");
CREATE INDEX        "customer_accounts_googleId_idx" ON "customer_accounts"("googleId");
