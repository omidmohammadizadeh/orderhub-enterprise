-- Auto publish: weekly schedule that re-pushes a menu to its marketplace channels.
CREATE TABLE "menu_auto_publish" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "times" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastResult" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_auto_publish_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "menu_auto_publish_menuId_key" ON "menu_auto_publish"("menuId");
CREATE INDEX "menu_auto_publish_enabled_nextRunAt_idx" ON "menu_auto_publish"("enabled", "nextRunAt");
CREATE INDEX "menu_auto_publish_tenantId_idx" ON "menu_auto_publish"("tenantId");
ALTER TABLE "menu_auto_publish" ADD CONSTRAINT "menu_auto_publish_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
