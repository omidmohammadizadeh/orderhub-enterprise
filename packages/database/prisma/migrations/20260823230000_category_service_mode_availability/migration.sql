-- Service-mode availability on the CATEGORY as well as the item.
--
-- Separate migration, not an edit to 20260823210000, which has already run on
-- production — changing a shipped migration fails its checksum and the API
-- never boots again.
--
-- Unticking thirty items one at a time is not something anyone will actually
-- do, so the switch has to exist at the level people think in. A category off
-- for a mode takes everything inside it with it.
--
-- All three default TRUE, so no existing category changes behaviour.
ALTER TABLE "menu_categories"
  ADD COLUMN "availableCollection" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "availableDelivery"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "availableDineIn"     BOOLEAN NOT NULL DEFAULT true;
