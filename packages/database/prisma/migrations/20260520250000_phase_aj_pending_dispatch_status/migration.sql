-- ── Phase AJ.5 — PENDING_DISPATCH OrderStatus value ─────────────────────────
-- Models orders that have been pushed to a third-party dispatcher
-- (Uber Direct / Stuart / Just Eat / Deliveroo when they assign their own
-- driver) but where no driver has accepted yet. Distinct from
-- ASSIGNED_DRIVER (driver picked) and OUT_FOR_DELIVERY (driver on the road).
--
-- Idempotent: ADD VALUE IF NOT EXISTS is a no-op when the value already
-- exists. Postgres requires this to run in its own transaction (which
-- Prisma does for us) — the new value is committed before any code can
-- attempt to USE it.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_DISPATCH';
