import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = 1;
const IV_BYTES = 16;

export interface EncryptedEnvelope {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  ct: string;
}

@Injectable()
export class CredentialEncryptionService {
  private readonly logger = new Logger(CredentialEncryptionService.name);
  private readonly key: Buffer | null;

  constructor() {
    const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!keyHex) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "CREDENTIAL_ENCRYPTION_KEY must be set in production. " +
            "Generate with: openssl rand -hex 32",
        );
      }
      this.logger.warn(
        "CREDENTIAL_ENCRYPTION_KEY not set — credentials stored as plaintext (dev/test only)",
      );
      this.key = null;
    } else {
      const buf = Buffer.from(keyHex, "hex");
      if (buf.length !== 32) {
        throw new Error(
          "CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes / 256 bits)",
        );
      }
      this.key = buf;
      this.logger.log("Credential encryption key loaded");
    }
  }

  encrypt(credentials: Record<string, unknown>): Record<string, unknown> {
    if (!this.key) return credentials;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const plaintext = JSON.stringify(credentials);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedEnvelope = {
      v: FORMAT_VERSION,
      alg: ALGORITHM,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ct: ct.toString("hex"),
    };
    return envelope as unknown as Record<string, unknown>;
  }

  decrypt(stored: Record<string, unknown>): Record<string, unknown> {
    if (!this.isEncrypted(stored)) return stored;

    if (!this.key) {
      this.logger.error(
        "Encrypted credentials found but CREDENTIAL_ENCRYPTION_KEY is not set.",
      );
      return stored;
    }

    const env = stored as unknown as EncryptedEnvelope;
    const iv = Buffer.from(env.iv, "hex");
    const tag = Buffer.from(env.tag, "hex");
    const ct = Buffer.from(env.ct, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
  }

  isEncrypted(value: unknown): value is EncryptedEnvelope {
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
}
