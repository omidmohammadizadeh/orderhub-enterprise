-- Sign in with Apple for the native restaurant apps.
ALTER TABLE "customer_accounts" ADD COLUMN "appleId" TEXT;
CREATE UNIQUE INDEX "customer_accounts_appleId_key" ON "customer_accounts"("appleId");
