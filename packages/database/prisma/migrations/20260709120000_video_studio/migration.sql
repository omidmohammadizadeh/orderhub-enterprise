-- AI Video Studio — paid add-on for AI-generated marketing videos.
--
-- video_studio_accounts: one per tenant. addonActive gates the feature;
--   includedBalance is the monthly allowance (reset each period), topupBalance
--   is purchased credits (persist). Total spendable = included + topup.
-- video_credit_txns: append-only ledger of every grant/topup/debit/refund.
-- video_generations: one row per render job (Replicate prediction), with the
--   credit refunded automatically if the render fails.

-- CreateEnum
CREATE TYPE "VideoGenStatus" AS ENUM ('QUEUED', 'RENDERING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "VideoCreditReason" AS ENUM ('GRANT', 'TOPUP', 'DEBIT', 'REFUND', 'ADJUST');

-- CreateTable
CREATE TABLE "video_studio_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "addonActive" BOOLEAN NOT NULL DEFAULT false,
    "stripeSubscriptionId" TEXT,
    "includedMonthly" INTEGER NOT NULL DEFAULT 0,
    "includedBalance" INTEGER NOT NULL DEFAULT 0,
    "topupBalance" INTEGER NOT NULL DEFAULT 0,
    "lastGrantAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_studio_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_studio_accounts_tenantId_key" ON "video_studio_accounts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "video_studio_accounts_stripeSubscriptionId_key" ON "video_studio_accounts"("stripeSubscriptionId");

-- CreateTable
CREATE TABLE "video_credit_txns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "VideoCreditReason" NOT NULL,
    "source" TEXT,
    "generationId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_credit_txns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_credit_txns_tenantId_createdAt_idx" ON "video_credit_txns"("tenantId", "createdAt");

-- CreateTable
CREATE TABLE "video_generations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "locationId" TEXT,
    "brandId" TEXT,
    "status" "VideoGenStatus" NOT NULL DEFAULT 'QUEUED',
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "sourceImageUrl" TEXT NOT NULL,
    "resultUrl" TEXT,
    "replicatePredictionId" TEXT,
    "creditsCost" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_generations_tenantId_createdAt_idx" ON "video_generations"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "video_generations_status_idx" ON "video_generations"("status");
