-- Bulk dispatch — one Stuart job can now carry several orders (a multi-drop
-- run, up to 8), so every order on the run shares a courierJobId and the job
-- id alone can no longer say which order a webhook is about. Each order keeps
-- its own leg's id here, and the webhook resolves by it first.
--
-- Additive and nullable: existing orders keep working through the
-- courierJobId fallback. A NEW migration, deliberately — editing a shipped one
-- changes its checksum and the API refuses to boot. IF NOT EXISTS keeps it
-- safe to re-run.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courierDeliveryId" TEXT;

CREATE INDEX IF NOT EXISTS "orders_courierDeliveryId_idx" ON "orders"("courierDeliveryId");
