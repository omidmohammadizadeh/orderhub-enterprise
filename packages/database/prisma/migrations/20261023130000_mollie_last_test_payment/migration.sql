-- Last dashboard test payment (test mode, no order) per connected brand.
ALTER TABLE "mollie_connections" ADD COLUMN "lastTestPaymentId" TEXT;
