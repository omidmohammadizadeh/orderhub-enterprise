-- Service charge (dine-in). Additive with a default so every existing
-- order reads as 0 and nothing recalculates retrospectively.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "serviceCharge" DECIMAL(10,2) NOT NULL DEFAULT 0;
