-- Phase AP-AUTH — Customer-facing accounts for the public storefront.
--
-- Separate from "users" (which is staff/admin only) so customers can never
-- accidentally inherit dashboard permissions and so JWT audiences stay
-- clean. One Customer record spans every restaurant on the platform.

CREATE TABLE IF NOT EXISTS "customers" (
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
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customers_email_key"     ON "customers"("email");
CREATE UNIQUE INDEX "customers_googleId_key"  ON "customers"("googleId");
CREATE INDEX        "customers_email_idx"     ON "customers"("email");
CREATE INDEX        "customers_googleId_idx"  ON "customers"("googleId");
