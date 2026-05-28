-- ── Phase AJ — order_status_history.tenantId ─────────────────────────────────
-- schema.prisma declares `tenantId String` on OrderStatusHistory, but the
-- init migration created the table without it. Every order.create() that
-- includes the nested statusHistory.create relation (i.e. every order)
-- fails with:
--
--   Invalid `prisma.order.create()` invocation:
--   The column `tenantId` does not exist in the current database.
--
-- The misleading bit: Prisma's error message doesn't say WHICH table is
-- missing the column. The stack trace pointed at orders.service.js
-- ingestCanonical → `tx.order.create({ ..., statusHistory: { create: ...
-- tenantId ... } })`, and we'd already verified `orders.tenantId` exists.
-- A quick `\d order_status_history` from the shell confirmed it's the
-- child table.
--
-- Fix is the same defensive idiom as the previous reconcile: add the
-- column IF NOT EXISTS, then create the index Prisma expects.

ALTER TABLE "order_status_history" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
CREATE INDEX IF NOT EXISTS "order_status_history_tenantId_createdAt_idx"
  ON "order_status_history"("tenantId", "createdAt" DESC);
