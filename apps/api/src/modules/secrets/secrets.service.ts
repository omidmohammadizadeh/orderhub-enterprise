import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PasswordService } from "../auth/services/password.service";
import { AuditLogService } from "../auth/services/audit-log.service";

// Phase AP — System Secrets vault.
//
// Stores third-party API keys (Stripe, Google Maps, getaddress.io,
// Supabase, etc.) in the database, encrypted at rest with AES-256-GCM.
// Other backend modules call `getSecret(key)` to read them instead of
// reading `process.env[key]` directly — the operator can rotate a key
// from the admin UI without redeploying.
//
// Security model:
//   • Master key in SECRETS_MASTER_KEY env var, 32 bytes base64-encoded.
//     The module refuses to start without it — no silent plaintext path.
//   • Every read + write is audit-logged with the actor's userId.
//   • The admin UI calls /v1/secrets/unlock with the admin's password
//     and gets a 10-min unlock JWT back. Reveal + write routes require
//     this JWT in the X-Secrets-Unlock header.
//   • Get/list responses never include the decrypted value; only
//     lastFourChars + metadata. The reveal route is the only thing
//     that returns plaintext.

const UNLOCK_TTL_SECONDS = 10 * 60;
const CACHE_TTL_MS = 60 * 1000;

interface CachedValue {
  value: string;
  cachedAt: number;
}

@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private readonly masterKey: Buffer | null;
  /** Per-process LRU-ish cache for getSecret() calls from other
   *  modules. 60s TTL means rotations propagate within a minute
   *  without us hitting the DB on every Stripe request. */
  private readonly cache = new Map<string, CachedValue>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly audit: AuditLogService,
  ) {
    const raw = process.env.SECRETS_MASTER_KEY;
    if (!raw) {
      this.masterKey = null;
      this.logger.warn(
        "SECRETS_MASTER_KEY is not set. The secrets vault is DISABLED — " +
          "list/get will work but only return env-var fallbacks; create/update will 503.",
      );
    } else {
      try {
        const key = Buffer.from(raw, "base64");
        if (key.length !== 32) {
          throw new Error(`expected 32 bytes, got ${key.length}`);
        }
        this.masterKey = key;
      } catch (err: any) {
        this.masterKey = null;
        this.logger.error(
          `SECRETS_MASTER_KEY is set but malformed (${err.message}). The vault is DISABLED.`,
        );
      }
    }
  }

  isEnabled(): boolean {
    return !!this.masterKey;
  }

  // ── Crypto ────────────────────────────────────────────────────────────────

  /** Encrypts plaintext → base64(iv ‖ authTag ‖ ciphertext). */
  private encrypt(plaintext: string): string {
    if (!this.masterKey) {
      throw new InternalServerErrorException(
        "Secrets vault is disabled. Set SECRETS_MASTER_KEY on the API service.",
      );
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
  }

  private decrypt(payload: string): string {
    if (!this.masterKey) {
      throw new InternalServerErrorException(
        "Secrets vault is disabled. Set SECRETS_MASTER_KEY on the API service.",
      );
    }
    const data = Buffer.from(payload, "base64");
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  // ── Unlock token (re-auth) ───────────────────────────────────────────────

  /** Verify the calling user's password and return a short-lived JWT
   *  that reveal + write routes require. */
  async unlock(
    userId: string,
    tenantId: string,
    password: string,
  ): Promise<{ token: string; expiresIn: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, role: true },
    });
    if (!user || !user.password) {
      throw new UnauthorizedException("Password not set for this account");
    }
    const ok = await this.passwords.compare(password, user.password);
    if (!ok) {
      await this.audit.log({
        tenantId,
        userId,
        event: "secrets.unlock.failed",
        resource: "secrets",
      });
      throw new UnauthorizedException("Incorrect password");
    }
    const token = await this.jwt.signAsync(
      { sub: userId, scope: "secrets:unlocked" },
      { expiresIn: UNLOCK_TTL_SECONDS },
    );
    await this.audit.log({
      tenantId,
      userId,
      event: "secrets.unlock.success",
      resource: "secrets",
    });
    return { token, expiresIn: UNLOCK_TTL_SECONDS };
  }

  /** Throws if the unlock token is missing / wrong scope / expired. */
  async assertUnlocked(userId: string, token: string | undefined) {
    if (!token) {
      throw new UnauthorizedException(
        "Re-enter your password to access secrets",
      );
    }
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException("Unlock expired — re-enter your password");
    }
    if (payload.scope !== "secrets:unlocked" || payload.sub !== userId) {
      throw new UnauthorizedException("Unlock token rejected");
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list() {
    const rows = await this.prisma.systemSecret.findMany({
      orderBy: [{ category: "asc" }, { key: "asc" }],
      select: {
        id: true,
        key: true,
        label: true,
        description: true,
        category: true,
        lastFourChars: true,
        createdBy: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows;
  }

  async reveal(
    userId: string,
    tenantId: string,
    key: string,
  ): Promise<{ key: string; value: string }> {
    const row = await this.prisma.systemSecret.findUnique({ where: { key } });
    if (!row) throw new NotFoundException("Secret not found");
    const value = this.decrypt(row.encryptedValue);
    await this.audit.log({
      tenantId,
      userId,
      event: "secrets.reveal",
      resource: "secrets",
      resourceId: row.id,
      meta: { key },
    });
    return { key: row.key, value };
  }

  async upsert(
    userId: string,
    tenantId: string,
    input: {
      key: string;
      value: string;
      label?: string;
      description?: string;
      category?: string;
    },
  ) {
    const key = input.key.trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new UnauthorizedException(
        "Key must be UPPER_SNAKE_CASE (matches env var convention).",
      );
    }
    const encrypted = this.encrypt(input.value);
    const lastFour =
      input.value.length >= 4 ? input.value.slice(-4) : input.value;
    const row = await this.prisma.systemSecret.upsert({
      where: { key },
      create: {
        key,
        label: input.label,
        description: input.description,
        category: input.category,
        encryptedValue: encrypted,
        lastFourChars: lastFour,
        createdBy: userId,
        updatedBy: userId,
      },
      update: {
        label: input.label,
        description: input.description,
        category: input.category,
        encryptedValue: encrypted,
        lastFourChars: lastFour,
        updatedBy: userId,
      },
      select: {
        id: true,
        key: true,
        label: true,
        description: true,
        category: true,
        lastFourChars: true,
        updatedAt: true,
      },
    });
    this.cache.delete(key);
    await this.audit.log({
      tenantId,
      userId,
      event: "secrets.upsert",
      resource: "secrets",
      resourceId: row.id,
      meta: { key, label: input.label, category: input.category },
    });
    return row;
  }

  async remove(userId: string, tenantId: string, key: string) {
    const row = await this.prisma.systemSecret.findUnique({ where: { key } });
    if (!row) throw new NotFoundException("Secret not found");
    await this.prisma.systemSecret.delete({ where: { key } });
    this.cache.delete(key);
    await this.audit.log({
      tenantId,
      userId,
      event: "secrets.delete",
      resource: "secrets",
      resourceId: row.id,
      meta: { key },
    });
  }

  // ── Read API for other modules ────────────────────────────────────────────

  /**
   * Returns the secret's plaintext value if present in the vault, else
   * falls back to `process.env[key]`. Cached for 60s per-process to
   * avoid hammering the DB on hot paths like Stripe webhooks.
   *
   * Other modules SHOULD prefer this over `process.env[...]` so the
   * operator can rotate keys without a redeploy.
   */
  async getSecret(key: string): Promise<string | undefined> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.value;
    }
    if (this.masterKey) {
      const row = await this.prisma.systemSecret.findUnique({
        where: { key },
        select: { encryptedValue: true },
      });
      if (row) {
        try {
          const value = this.decrypt(row.encryptedValue);
          this.cache.set(key, { value, cachedAt: Date.now() });
          return value;
        } catch (err: any) {
          this.logger.warn(
            `Failed to decrypt secret "${key}": ${err.message} — falling back to env var`,
          );
        }
      }
    }
    const fromEnv = process.env[key];
    if (fromEnv !== undefined) {
      this.cache.set(key, { value: fromEnv, cachedAt: Date.now() });
    }
    return fromEnv;
  }

  /** Manual cache flush — useful for tests + after an upsert. */
  invalidate(key?: string) {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}
