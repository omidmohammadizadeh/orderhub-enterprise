-- Walk-in loyalty members are keyed by email (codes and links by email).
ALTER TABLE "loyalty_members" ADD COLUMN "email" TEXT;
CREATE UNIQUE INDEX "loyalty_members_cardId_email_key" ON "loyalty_members"("cardId", "email");
