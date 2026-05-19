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
  kid?: string; // key ID — added when encrypting; absent on v1 envelopes (pre-rotation)
}

@Injectable()
export class CredentialEncryptionService {
  private readonly logger = new Logger(CredentialEncryptionService.name);
  private readonly currentKey: Buffer | null;
  private readonly currentKeyId: string;
  private readonly previousKey: Buffer | null;

  constructor() {
    // Key resolution order:
    //   CREDENTIAL_ENCRYPTION_KEY_CURRENT  (preferred — use during rotation)
    //   CREDENTIAL_ENCRYPTION_KEY          (legacy alias — still supported)
    const currentHex =
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ??
      process.env.CREDENTIAL_ENCRYPTION_KEY;

    if (!currentHex) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "CREDENTIAL_ENCRYPTION_KEY (or CREDENTIAL_ENCRYPTION_KEY_CURRENT) must be set in production. " +
            "Generate with: openssl rand -hex 32",
        );
      }
      this.logger.warn(
        "CREDENTIAL_ENCRYPTION_KEY not set — credentials stored as plaintext (dev/test only)",
      );
      this.currentKey = null;
    } else {
      const buf = Buffer.from(currentHex, "hex");
      if (buf.length !== 32) {
        throw new Error(
          "CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes / 256 bits)",
        );
      }
      this.currentKey = buf;
      this.logger.log("Credential encryption key loaded");
    }

    this.currentKeyId = process.env.CREDENTIAL_ENCRYPTION_KEY_ID ?? "v1";

    // Previous key — used as fallback during rotation so old ciphertext remains readable
    const previousHex = process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    if (previousHex) {
      const buf = Buffer.from(previousHex, "hex");
      if (buf.length !== 32) {
        throw new Error("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS must be exactly 64 hex characters");
      }
      this.previousKey = buf;
      this.logger.log("Previous credential encryption key loaded (rotation in progress)");
    } else {
      this.previousKey = null;
    }
  }

  get keyId(): string {
    return this.currentKeyId;
  }

  get hasPreviousKey(): boolean {
    return this.previousKey !== null;
  }

  encrypt(credentials: Record<string, unknown>): Record<string, unknown> {
    if (!this.currentKey) return credentials;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.currentKey, iv);
    const plaintext = JSON.stringify(credentials);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedEnvelope = {
      v: FORMAT_VERSION,
      alg: ALGORITHM,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ct: ct.toString("hex"),
      kid: this.currentKeyId,
    };
    return envelope as unknown as Record<string, unknown>;
  }

  decrypt(stored: Record<string, unknown>): Record<string, unknown> {
    if (!this.isEncrypted(stored)) return stored;

    if (!this.currentKey) {
      this.logger.error(
        "Encrypted credentials found but CREDENTIAL_ENCRYPTION_KEY is not set. " +
          "Provider API calls will fail until the key is configured.",
      );
      return stored;
    }

    // Try current key first; fall back to previous key if auth tag verification fails.
    try {
      return this.decryptWithKey(stored as unknown as EncryptedEnvelope, this.currentKey);
    } catch {
      if (this.previousKey) {
        try {
          const result = this.decryptWithKey(stored as unknown as EncryptedEnvelope, this.previousKey);
          this.logger.debug("Decrypted credential with previous key — rotation pending for this record");
          return result;
        } catch {
          throw new Error("Credential decryption failed with both current and previous keys");
        }
      }
      throw new Error("Credential decryption failed — auth tag mismatch");
    }
  }

  private decryptWithKey(env: EncryptedEnvelope, key: Buffer): Record<string, unknown> {
    const iv = Buffer.from(env.iv, "hex");
    const tag = Buffer.from(env.tag, "hex");
    const ct = Buffer.from(env.ct, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
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

  isEncryptedWithCurrentKey(value: unknown): boolean {
    if (!this.isEncrypted(value)) return false;
    const env = value as EncryptedEnvelope;
    // kid absent = pre-rotation envelope; treat as needing re-encryption
    return env.kid === this.currentKeyId;
  }

  /** Returns how many integration credential blobs are currently unencrypted. */
  countPlaintext(credentials: unknown[]): number {
    return credentials.filter((c) => !this.isEncrypted(c)).length;
  }

  /** Returns how many credentials are encrypted with the current key (have correct kid). */
  countCurrentKey(credentials: unknown[]): number {
    return credentials.filter((c) => this.isEncryptedWithCurrentKey(c)).length;
  }

  /** Returns how many credentials are encrypted with a different/old key. */
  countOldKey(credentials: unknown[]): number {
    return credentials.filter(
      (c) => this.isEncrypted(c) && !this.isEncryptedWithCurrentKey(c),
    ).length;
  }
}
