-- Customer gratuity, kept by the restaurant. Defaulted so every existing
-- order reads 0 rather than null; historic orders folded the tip into the
-- total with no way to separate it.
ALTER TABLE "orders" ADD COLUMN "tipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
