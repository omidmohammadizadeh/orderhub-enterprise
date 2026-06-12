-- Phase AP-5 — Customer "My Orders" page support.
--
-- Two additive, nullable columns. No backfill needed:
--
--   * orders.customerAccountId — links an Order to the auth identity
--     that placed it. Populated at storefront checkout time when the
--     customer is signed in. Null for guest checkouts and pre-AP-5
--     orders.
--
--   * locations.googleReviewUrl — operator-supplied Google Business
--     Profile review URL. Surfaces the "Leave Google review" button
--     on the customer's completed-order card. Null hides the button.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "customerAccountId" TEXT;

CREATE INDEX IF NOT EXISTS "orders_customerAccountId_idx"
  ON "orders"("customerAccountId");

-- onDelete: SetNull mirrors the Prisma schema. We don't enforce a FK
-- constraint via DDL here because the application layer treats this as
-- a soft reference (a customer deleting their account shouldn't cascade
-- through their order history — orders persist with the link nulled).
-- If we ever want strict referential integrity, add the FK in a later
-- migration after auditing existing data.

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "googleReviewUrl" TEXT;
