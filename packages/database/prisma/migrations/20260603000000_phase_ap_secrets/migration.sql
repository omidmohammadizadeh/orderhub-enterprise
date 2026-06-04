-- Phase AP — System Secrets vault.
--
-- Encrypted at rest with AES-256-GCM. The DB never sees plaintext —
-- only the last 4 characters of the value are stored (as
-- lastFourChars) so the admin UI can show "sk_live_••••4u9X" without
-- needing to decrypt.

CREATE TABLE IF NOT EXISTS "system_secrets" (
  "id"             TEXT NOT NULL,
  "key"            TEXT NOT NULL,
  "label"          TEXT,
  "description"    TEXT,
  "category"       TEXT,
  -- base64(iv || authTag || ciphertext)
  "encryptedValue" TEXT NOT NULL,
  "lastFourChars"  TEXT,
  "createdBy"      TEXT,
  "updatedBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_secrets_key_key"
  ON "system_secrets"("key");
CREATE INDEX IF NOT EXISTS "system_secrets_category_idx"
  ON "system_secrets"("category");
