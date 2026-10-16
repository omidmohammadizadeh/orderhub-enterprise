-- Saved delivery address + date of birth on the customer's own account.
-- All nullable: existing accounts are untouched until the customer fills them in.
ALTER TABLE "customer_accounts" ADD COLUMN "addressLine1" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN "addressLine2" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN "addressPostcode" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN "addressArea" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN "dateOfBirth" DATE;
