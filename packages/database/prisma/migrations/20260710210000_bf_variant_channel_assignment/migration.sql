-- Phase BF — variant-menu publish for direct channels. A menu_channel_assignments
-- row (the "this menu serves (location, channel, brand)" slot) can now
-- optionally price itself from a NAMED PRICING VARIANT defined on a
-- different menu, instead of its own base prices — reusing the same
-- variant-pricing data already built for the shared HubRise catalog.
ALTER TABLE "menu_channel_assignments"
  ADD COLUMN "variantSourceMenuId" TEXT,
  ADD COLUMN "variantRef" TEXT;

ALTER TABLE "menu_channel_assignments"
  ADD CONSTRAINT "menu_channel_assignments_variantSourceMenuId_fkey"
  FOREIGN KEY ("variantSourceMenuId") REFERENCES "menus"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "menu_channel_assignments_variantSourceMenuId_idx"
  ON "menu_channel_assignments"("variantSourceMenuId");
