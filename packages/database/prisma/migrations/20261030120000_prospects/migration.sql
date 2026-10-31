-- Admin Dashboard → Prospects: private shop previews and commission reports.
CREATE TABLE "prospects" (
    "id" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "city" TEXT,
    "postcode" TEXT,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "previewToken" TEXT NOT NULL,
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "menu" JSONB,
    "menuStatus" TEXT NOT NULL DEFAULT 'NONE',
    "menuError" TEXT,
    "hygiene" JSONB,
    "statements" JSONB NOT NULL DEFAULT '[]',
    "statementStatus" TEXT NOT NULL DEFAULT 'NONE',
    "statementError" TEXT,
    "assumptions" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prospects_previewToken_key" ON "prospects"("previewToken");
CREATE INDEX "prospects_createdAt_idx" ON "prospects"("createdAt" DESC);
