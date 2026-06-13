-- Phase AR — Team Roles
--
-- Adds new UserRole enum values (without removing the legacy ones, so
-- every controller decorated with @Roles("TENANT_OWNER", ...) keeps
-- working unchanged). Introduces UserLocation + UserBrand join tables
-- so a single user can have access to many locations / brands within
-- their tenant, and an Invitation table for the invite-by-email flow.

-- ── New role values ──────────────────────────────────────────────
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'DARK_KITCHEN_MANAGER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'STAFF';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ONBOARDING_AGENT';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'FINANCIAL_AGENT';

-- ── UserLocation ──────────────────────────────────────────────────
CREATE TABLE "user_locations" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "locationId"  TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_locations_userId_locationId_key"
  ON "user_locations"("userId", "locationId");
CREATE INDEX "user_locations_userId_idx" ON "user_locations"("userId");
CREATE INDEX "user_locations_locationId_idx" ON "user_locations"("locationId");
ALTER TABLE "user_locations"
  ADD CONSTRAINT "user_locations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "user_locations"
  ADD CONSTRAINT "user_locations_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;

-- ── UserBrand ─────────────────────────────────────────────────────
CREATE TABLE "user_brands" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "brandId"    TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_brands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_brands_userId_brandId_key"
  ON "user_brands"("userId", "brandId");
CREATE INDEX "user_brands_userId_idx" ON "user_brands"("userId");
CREATE INDEX "user_brands_brandId_idx" ON "user_brands"("brandId");
ALTER TABLE "user_brands"
  ADD CONSTRAINT "user_brands_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "user_brands"
  ADD CONSTRAINT "user_brands_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE;

-- ── Invitation ────────────────────────────────────────────────────
CREATE TABLE "invitations" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "role"         "UserRole" NOT NULL,
  "locationIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "brandIds"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "token"        TEXT NOT NULL,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "acceptedAt"   TIMESTAMP(3),
  "cancelledAt"  TIMESTAMP(3),
  "invitedById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");
CREATE INDEX "invitations_tenantId_idx" ON "invitations"("tenantId");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");
CREATE INDEX "invitations_tenantId_acceptedAt_idx"
  ON "invitations"("tenantId", "acceptedAt");
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL;
