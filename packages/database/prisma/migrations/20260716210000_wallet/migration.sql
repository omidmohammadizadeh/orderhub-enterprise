-- Prepaid SMS wallet: per-tenant GBP balance (pennies) + immutable ledger.

CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "balanceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "smsPricePerSegmentMinor" INTEGER,
    "lowBalanceThresholdMinor" INTEGER NOT NULL DEFAULT 200,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallets_tenantId_key" ON "wallets"("tenantId");

CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "balanceAfterMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "purpose" TEXT,
    "segments" INTEGER,
    "smsMessageId" TEXT,
    "locationId" TEXT,
    "stripeCheckoutId" TEXT,
    "stripePaymentIntentId" TEXT,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wallet_transactions_tenantId_createdAt_idx" ON "wallet_transactions"("tenantId", "createdAt");
CREATE INDEX "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");
CREATE INDEX "wallet_transactions_stripePaymentIntentId_idx" ON "wallet_transactions"("stripePaymentIntentId");

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
