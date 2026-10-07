-- "Trusted by" brand wall on the marketing homepage (Admin → Website showcase).
ALTER TABLE "brands" ADD COLUMN "showcaseOnWebsite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "brands" ADD COLUMN "showcaseOrder" INTEGER;
