-- Kitchen-language name: the customer menu stays English, the kitchen ticket
-- prints this when set. Nullable with no default, so every existing row keeps
-- printing exactly what it prints today.
ALTER TABLE "menu_items" ADD COLUMN "secondLanguageName" TEXT;
ALTER TABLE "modifier_options" ADD COLUMN "secondLanguageName" TEXT;
ALTER TABLE "menu_categories" ADD COLUMN "secondLanguageName" TEXT;
