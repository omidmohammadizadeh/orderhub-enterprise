-- One brand's Mollie Connect account (opt-in alongside Stripe).
CREATE TABLE "mollie_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "organizationId" TEXT,
    "organizationName" TEXT,
    "profileId" TEXT,
    "accessTokenEnc" JSONB,
    "refreshTokenEnc" JSONB,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "canReceivePayments" BOOLEAN NOT NULL DEFAULT false,
    "canReceiveSettlements" BOOLEAN NOT NULL DEFAULT false,
    "onboardingDashboardUrl" TEXT,
    "clientLinkId" TEXT,
    "clientLinkUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mollie_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mollie_connections_brandId_key" ON "mollie_connections"("brandId");
CREATE INDEX "mollie_connections_tenantId_idx" ON "mollie_connections"("tenantId");
