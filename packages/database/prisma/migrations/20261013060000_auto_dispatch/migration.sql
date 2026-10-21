-- Auto dispatch: rules that send delivery orders to a courier network on
-- their own, and one claim row per order they pick up. Additive only.
CREATE TABLE "auto_dispatch_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "locationId" TEXT,
    "brandIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "strategy" TEXT NOT NULL DEFAULT 'FIXED',
    "providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fallback" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL DEFAULT 'ON_ACCEPT',
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "maxPriceMinor" INTEGER,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_dispatch_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auto_dispatch_rules_tenantId_enabled_idx" ON "auto_dispatch_rules"("tenantId", "enabled");

CREATE TABLE "auto_dispatch_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "quotes" JSONB,
    "provider" TEXT,
    "priceMinor" INTEGER,
    "jobId" TEXT,
    "error" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_dispatch_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auto_dispatch_runs_orderId_key" ON "auto_dispatch_runs"("orderId");
CREATE INDEX "auto_dispatch_runs_status_dueAt_idx" ON "auto_dispatch_runs"("status", "dueAt");
CREATE INDEX "auto_dispatch_runs_tenantId_createdAt_idx" ON "auto_dispatch_runs"("tenantId", "createdAt" DESC);
