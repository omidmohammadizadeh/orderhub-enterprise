-- Phase AZ — location-level prep time (base + busy-mode extra).
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "prepTime" INTEGER;
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "busyExtraPrepTime" INTEGER;
