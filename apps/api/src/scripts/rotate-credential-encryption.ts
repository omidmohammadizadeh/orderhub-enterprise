/**
 * Key rotation script: re-encrypts all Integration credentials from the old key to the new key.
 *
 * Environment variables required:
 *   CREDENTIAL_ENCRYPTION_KEY_CURRENT   — the NEW key (64 hex chars / 32 bytes)
 *   CREDENTIAL_ENCRYPTION_KEY_PREVIOUS  — the OLD key (64 hex chars / 32 bytes)
 *   CREDENTIAL_ENCRYPTION_KEY_ID        — ID for the new key (e.g. "v2")
 *   DATABASE_URL                        — Postgres connection string
 *
 * Optional:
 *   DRY_RUN=true  — analyse without writing
 *
 * Usage:
 *   DRY_RUN=true \
 *     CREDENTIAL_ENCRYPTION_KEY_CURRENT=<new-hex> \
 *     CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=<old-hex> \
 *     CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
 *     DATABASE_URL=<url> \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/rotate-credential-encryption.ts
 */

import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = 1;
const IV_BYTES = 16;

function requireKeyFromEnv(envVar: string): Buffer {
  const hex = process.env[envVar];
  if (!hex) throw new Error(`${envVar} is required`);
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error(`${envVar} must be exactly 64 hex characters`);
  return buf;
}

function isEncrypted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === FORMAT_VERSION &&
    v["alg"] === ALGORITHM &&
    typeof v["iv"] === "string" &&
    typeof v["tag"] === "string" &&
    typeof v["ct"] === "string"
  );
}

function decryptWithKey(stored: Record<string, any>, key: Buffer): Record<string, unknown> {
  const iv = Buffer.from(stored.iv, "hex");
  const tag = Buffer.from(stored.tag, "hex");
  const ct = Buffer.from(stored.ct, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function encryptWithKey(
  credentials: Record<string, unknown>,
  key: Buffer,
  keyId: string,
): Record<string, unknown> {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return {
    v: FORMAT_VERSION,
    alg: ALGORITHM,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ct: ct.toString("hex"),
    kid: keyId,
  };
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const newKeyId = process.env.CREDENTIAL_ENCRYPTION_KEY_ID ?? "v2";
  const newKey = requireKeyFromEnv("CREDENTIAL_ENCRYPTION_KEY_CURRENT");
  const oldKey = requireKeyFromEnv("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS");

  console.log(`Key rotation${dryRun ? " [DRY RUN]" : ""}`);
  console.log(`  New key ID : ${newKeyId}`);
  console.log(`  Old key    : ...${process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS!.slice(-8)}`);
  console.log(`  New key    : ...${process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT!.slice(-8)}`);
  console.log();

  const prisma = new PrismaClient();

  try {
    const integrations = await prisma.integration.findMany({
      select: { id: true, credentials: true },
    });

    let alreadyCurrent = 0;
    let plaintext = 0;
    let rotated = 0;
    let failed = 0;

    for (const integration of integrations) {
      const creds = integration.credentials as Record<string, unknown>;

      if (!isEncrypted(creds)) {
        console.log(`[SKIP] ${integration.id} — plaintext (run backfill first)`);
        plaintext++;
        continue;
      }

      const stored = creds as Record<string, any>;

      // Already encrypted with new key
      if (stored.kid === newKeyId) {
        alreadyCurrent++;
        continue;
      }

      // Attempt decryption with old key
      let decrypted: Record<string, unknown>;
      try {
        decrypted = decryptWithKey(stored, oldKey);
      } catch {
        console.error(`[ERROR] ${integration.id} — cannot decrypt with old key`);
        failed++;
        continue;
      }

      const reEncrypted = encryptWithKey(decrypted, newKey, newKeyId);

      if (!dryRun) {
        await prisma.integration.update({
          where: { id: integration.id },
          data: { credentials: reEncrypted },
        });
      }

      console.log(`[${dryRun ? "WOULD ROTATE" : "ROTATED"}] ${integration.id}`);
      rotated++;
    }

    console.log();
    console.log("Summary");
    console.log(`  Total integrations   : ${integrations.length}`);
    console.log(`  Already current key  : ${alreadyCurrent}`);
    console.log(`  Rotated              : ${rotated}`);
    console.log(`  Plaintext (skipped)  : ${plaintext}`);
    console.log(`  Failed               : ${failed}`);

    if (dryRun) {
      console.log();
      console.log("Dry run complete — no changes written. Re-run without DRY_RUN=true to apply.");
    }

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
