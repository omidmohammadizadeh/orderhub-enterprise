-- Open-price items were replaced by the POS "Extra charge" button before they
-- were ever used: pricing an off-menu request belongs at the till, not as a
-- menu row a customer might see.
--
-- The ADD in 20260902090000 is left in place rather than edited out. An
-- already-shipped migration must never be rewritten — the checksum stops the
-- API booting — so the column is dropped forward instead.
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "openPrice";
