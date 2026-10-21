-- Salon S1 — barbers, hair and nail salons. Purely additive:
--
--   * BusinessType gains SALON (a preset, like GROCERY/RETAIL: every existing
--     location stays RESTAURANT and behaves exactly as before).
--   * salon_services / salon_staff / salon_time_off — the price list with
--     durations, the people who can be booked, and when they can't be.
--   * salon_appointments — one client, one staff member, services copied in.
--   * salon_queue_entries — the barber's walk-in queue.

-- AlterEnum
ALTER TYPE "BusinessType" ADD VALUE IF NOT EXISTS 'SALON';

-- CreateTable
CREATE TABLE "salon_services" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Services',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "priceFrom" BOOLEAN NOT NULL DEFAULT false,
    "durationMins" INTEGER NOT NULL DEFAULT 30,
    "bufferMins" INTEGER NOT NULL DEFAULT 0,
    "processingStartMins" INTEGER,
    "processingMins" INTEGER,
    "depositType" TEXT NOT NULL DEFAULT 'NONE',
    "depositValue" DECIMAL(10,2),
    "requiresPatchTest" BOOLEAN NOT NULL DEFAULT false,
    "bookableOnline" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "addons" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_staff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "colour" TEXT NOT NULL DEFAULT '#f97316',
    "bookableOnline" BOOLEAN NOT NULL DEFAULT true,
    "acceptsWalkIns" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "weeklyHours" JSONB NOT NULL DEFAULT '{}',
    "serviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priceOverrides" JSONB NOT NULL DEFAULT '{}',
    "commissionPercent" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_time_off" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_appointments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "staffId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "source" TEXT NOT NULL DEFAULT 'STAFF',
    "anyStaff" BOOLEAN NOT NULL DEFAULT false,
    "services" JSONB NOT NULL DEFAULT '[]',
    "totalPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "staffNotes" TEXT,
    "reference" TEXT NOT NULL,
    "manageToken" TEXT NOT NULL,
    "depositAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "depositStatus" TEXT NOT NULL DEFAULT 'NONE',
    "depositOrderId" TEXT,
    "depositPaidAt" TIMESTAMP(3),
    "orderId" TEXT,
    "tipAmount" DECIMAL(10,2),
    "checkedInAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "rebookNudgeSentAt" TIMESTAMP(3),
    "queueEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_queue_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "serviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceSummary" TEXT,
    "estimatedMins" INTEGER NOT NULL DEFAULT 30,
    "preferredStaffId" TEXT,
    "staffId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "source" TEXT NOT NULL DEFAULT 'STAFF',
    "publicToken" TEXT NOT NULL,
    "calledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "appointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_queue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salon_services_tenantId_idx" ON "salon_services"("tenantId");

-- CreateIndex
CREATE INDEX "salon_services_locationId_idx" ON "salon_services"("locationId");

-- CreateIndex
CREATE INDEX "salon_staff_tenantId_idx" ON "salon_staff"("tenantId");

-- CreateIndex
CREATE INDEX "salon_staff_locationId_idx" ON "salon_staff"("locationId");

-- CreateIndex
CREATE INDEX "salon_time_off_staffId_startsAt_idx" ON "salon_time_off"("staffId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "salon_appointments_reference_key" ON "salon_appointments"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "salon_appointments_manageToken_key" ON "salon_appointments"("manageToken");

-- CreateIndex
CREATE INDEX "salon_appointments_tenantId_idx" ON "salon_appointments"("tenantId");

-- CreateIndex
CREATE INDEX "salon_appointments_locationId_startsAt_idx" ON "salon_appointments"("locationId", "startsAt");

-- CreateIndex
CREATE INDEX "salon_appointments_staffId_startsAt_idx" ON "salon_appointments"("staffId", "startsAt");

-- CreateIndex
CREATE INDEX "salon_appointments_status_idx" ON "salon_appointments"("status");

-- CreateIndex
CREATE INDEX "salon_appointments_orderId_idx" ON "salon_appointments"("orderId");

-- CreateIndex
CREATE INDEX "salon_appointments_depositOrderId_idx" ON "salon_appointments"("depositOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "salon_queue_entries_publicToken_key" ON "salon_queue_entries"("publicToken");

-- CreateIndex
CREATE INDEX "salon_queue_entries_tenantId_idx" ON "salon_queue_entries"("tenantId");

-- CreateIndex
CREATE INDEX "salon_queue_entries_locationId_status_idx" ON "salon_queue_entries"("locationId", "status");

-- AddForeignKey
ALTER TABLE "salon_services" ADD CONSTRAINT "salon_services_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_staff" ADD CONSTRAINT "salon_staff_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_time_off" ADD CONSTRAINT "salon_time_off_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "salon_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_appointments" ADD CONSTRAINT "salon_appointments_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_appointments" ADD CONSTRAINT "salon_appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "salon_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_queue_entries" ADD CONSTRAINT "salon_queue_entries_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
