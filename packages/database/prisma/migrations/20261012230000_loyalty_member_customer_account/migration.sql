-- Link a walk-in loyalty member to a storefront account, so online orders and
-- till visits fill one card and one wallet pass.
ALTER TABLE "loyalty_members" ADD COLUMN "customerAccountId" TEXT;
CREATE UNIQUE INDEX "loyalty_members_cardId_customerAccountId_key" ON "loyalty_members"("cardId", "customerAccountId");
