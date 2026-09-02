-- "Ask for the price at the till" items: the off-menu request an operator
-- prices as they ring it up. Never customer-facing — the API forces
-- visibleToCustomers false alongside it.
ALTER TABLE "menu_items" ADD COLUMN "openPrice" BOOLEAN NOT NULL DEFAULT false;
