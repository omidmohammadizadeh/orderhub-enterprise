-- Per-item service-mode availability.
--
-- All three default TRUE so every existing row keeps behaving exactly as it
-- does today: the migration is additive and changes no menu.
--
-- These are a permanent property of the product, not stock state. A 20"
-- sharing pizza that does not survive a moped is not "out of stock" — it is
-- simply not a delivery item, and it should never be offered as one.
ALTER TABLE "menu_items"
  ADD COLUMN "availableCollection" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "availableDelivery"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "availableDineIn"     BOOLEAN NOT NULL DEFAULT true;
