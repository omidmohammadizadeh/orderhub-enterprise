/**
 * Backfill Credential Encryption
 *
 * Scans all Integration rows and encrypts any that still have plaintext credentials.
 * Safe to re-run — already-encrypted rows are skipped.
 *
 * Usage:
 *   CREDENTIAL_ENCRYPTION_KEY=<64-hex-chars> DATABASE_URL=<url> \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/backfill-credential-encryption.ts
 *
 * Dry-run (no writes):
 *   DRY_RUN=true CREDENTIAL_ENCRYPTION_KEY=<key> DATABASE_URL=<url> \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/backfill-credential-encryption.ts
 */

import * as crypto from "crypto";
import { PrismaClient } from "@orderhub/database";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = 1;
const IV_BYTES = 16;

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

function encrypt(credentials: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(credentials);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: FORMAT_VERSION,
    alg: ALGORITHM,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: ct.toString("hex"),
  };
}

async function main() {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!keyHex) {
    console.error("ERROR: CREDENTIAL_ENCRYPTION_KEY is required");
    process.exit(1);
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    console.error("ERROR: CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
    process.exit(1);
  }

  const dryRun = process.env.DRY_RUN === "true";
  if (dryRun) {
    console.log("DRY RUN mode — no writes will be made");
  }

  const prisma = new PrismaClient();

  try {
    const integrations = await prisma.integration.findMany({
      where: { deletedAt: null },
      select: { id: true, credentials: true, platform: true, locationId: true },
    });

    console.log(`Found ${integrations.length} active integration(s)`);

    let encrypted = 0;
    let alreadyEncrypted = 0;
    let errors = 0;

    for (const integration of integrations) {
      const creds = integration.credentials as Record<string, unknown>;

      if (isEncrypted(creds)) {
        alreadyEncrypted++;
        continue;
      }

      try {
        const encryptedCreds = encrypt(creds, key);
        if (!dryRun) {
          await prisma.integration.update({
            where: { id: integration.id },
            data: { credentials: encryptedCreds as any },
          });
        }
        console.log(
          `  ${dryRun ? "[DRY RUN] Would encrypt" : "Encrypted"}: ${integration.id} (${integration.platform} @ ${integration.locationId})`,
        );
        encrypted++;
      } catch (err: any) {
        console.error(`  ERROR encrypting ${integration.id}: ${err.message}`);
        errors++;
      }
    }

    console.log("");
    console.log("─".repeat(50));
    console.log(`Already encrypted : ${alreadyEncrypted}`);
    console.log(`${dryRun ? "Would encrypt" : "Encrypted"}      : ${encrypted}`);
    console.log(`Errors            : ${errors}`);

    if (errors > 0) {
      console.error("\nBackfill completed with errors. Check the output above.");
      process.exit(1);
    }

    console.log("\nBackfill complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
