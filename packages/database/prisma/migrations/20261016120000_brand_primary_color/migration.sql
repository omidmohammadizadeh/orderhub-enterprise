-- Per-brand storefront colour. Nullable: a brand without one keeps the
-- storefront's default accent.
ALTER TABLE "brands" ADD COLUMN "primaryColor" TEXT;
