-- Phase AY (P2) — rolling AI chat transcript for WhatsApp conversations.
ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "messages" JSONB NOT NULL DEFAULT '[]';
