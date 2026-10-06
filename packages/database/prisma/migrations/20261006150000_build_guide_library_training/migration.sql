-- "How to build" phase 3: reusable step library + training completions.
CREATE TABLE "build_step_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "imageUrl" TEXT,
    "amount" TEXT,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "build_step_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "build_step_templates_tenantId_idx" ON "build_step_templates"("tenantId");

CREATE TABLE "build_guide_trainings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_guide_trainings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "build_guide_trainings_guideId_userId_key" ON "build_guide_trainings"("guideId", "userId");
CREATE INDEX "build_guide_trainings_tenantId_userId_idx" ON "build_guide_trainings"("tenantId", "userId");
ALTER TABLE "build_guide_trainings" ADD CONSTRAINT "build_guide_trainings_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "build_guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;
