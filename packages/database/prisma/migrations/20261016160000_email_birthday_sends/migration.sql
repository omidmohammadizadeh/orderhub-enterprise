-- Birthday emails: one claim row per (automation, address, year).
CREATE TABLE "email_birthday_sends" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_birthday_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_birthday_sends_automationId_email_year_key" ON "email_birthday_sends"("automationId", "email", "year");
CREATE INDEX "email_birthday_sends_tenantId_createdAt_idx" ON "email_birthday_sends"("tenantId", "createdAt");
