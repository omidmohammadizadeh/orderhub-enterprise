-- Storefront "Top sellers" rail: the items an operator pins above the menu.
-- Ids, not a relation — removing an item from the menu should silently drop it
-- from the rail rather than fail on a foreign key.
ALTER TABLE "brands" ADD COLUMN "topSellerItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
