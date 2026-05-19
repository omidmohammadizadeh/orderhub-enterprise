import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { QUEUES } from "@orderhub/shared";
import * as crypto from "crypto";

/**
 * Runs critical infrastructure checks at module init in production.
 * A failed check logs a clear operator-friendly message and kills the process
 * rather than starting in a broken state that would silently corrupt data.
 *
 * Never logs credential values or key material.
 */
@Injectable()
export class ProductionStartupService implements OnModuleInit {
  private readonly logger = new Logger(ProductionStartupService.name);
  private readonly isProduction = process.env.NODE_ENV === "production";

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.isProduction) return;

    this.logger.log("Running production startup validation...");

    const errors: string[] = [];

    errors.push(...this.validateEncryptionKey());
    errors.push(...this.validateJwtSecret());
    errors.push(...this.validateCorsConfig());

    // Async checks
    const [dbError, redisError] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);
    if (dbError) errors.push(dbError);
    if (redisError) errors.push(redisError);

    if (errors.length > 0) {
      for (const err of errors) {
        this.logger.error(`STARTUP FAILED: ${err}`);
      }
      this.logger.error(
        `${errors.length} critical startup check(s) failed. Refusing to start in production.`,
      );
      process.exit(1);
    }

    this.logger.log("Production startup validation passed.");
  }

  // ── Synchronous checks ────────────────────────────────────────────────────

  private validateEncryptionKey(): string[] {
    const key =
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ??
      process.env.CREDENTIAL_ENCRYPTION_KEY;

    if (!key) {
      return [
        "CREDENTIAL_ENCRYPTION_KEY (or CREDENTIAL_ENCRYPTION_KEY_CURRENT) is not set. " +
          "Generate with: openssl rand -hex 32",
      ];
    }

    const buf = Buffer.from(key, "hex");
    if (buf.length !== 32) {
      return [
        "CREDENTIAL_ENCRYPTION_KEY is not a valid 32-byte hex key (must be 64 hex characters).",
      ];
    }

    // Quick encrypt/decrypt roundtrip to verify the key works
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv("aes-256-gcm", buf, iv);
      const ct = Buffer.concat([cipher.update("startup-check", "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      const decipher = crypto.createDecipheriv("aes-256-gcm", buf, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");

      if (plain !== "startup-check") {
        return ["CREDENTIAL_ENCRYPTION_KEY roundtrip failed — key may be corrupt."];
      }
    } catch {
      return ["CREDENTIAL_ENCRYPTION_KEY roundtrip threw an error — key is invalid."];
    }

    return [];
  }

  private validateJwtSecret(): string[] {
    const secret = process.env.JWT_SECRET ?? "";
    const insecureValues = ["change-me", "secret", "password", "jwt-secret", "default"];

    for (const bad of insecureValues) {
      if (secret.toLowerCase().includes(bad)) {
        return [
          `JWT_SECRET contains insecure value. Generate with: openssl rand -base64 48`,
        ];
      }
    }

    if (secret.length < 32) {
      return ["JWT_SECRET must be at least 32 characters in production."];
    }

    return [];
  }

  private validateCorsConfig(): string[] {
    const corsOrigin = process.env.SOCKET_CORS_ORIGIN ?? "";
    const appUrl = process.env.APP_URL ?? "";

    const warnings: string[] = [];

    if (corsOrigin === "*") {
      warnings.push(
        "SOCKET_CORS_ORIGIN is wildcard (*) — restrict to your production frontend domain.",
      );
    }

    if (appUrl.includes("localhost")) {
      warnings.push(
        `APP_URL is "${appUrl}" in production — set to the production frontend URL.`,
      );
    }

    // Warn only (non-fatal) — log and continue
    for (const w of warnings) {
      this.logger.warn(`CORS WARNING: ${w}`);
    }

    return []; // CORS issues are warnings, not fatal startup blockers
  }

  // ── Async checks ──────────────────────────────────────────────────────────

  private async checkDatabase(): Promise<string | null> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      this.logger.log("Database connection: OK");
      return null;
    } catch (err: any) {
      return `Database connection failed: ${err?.message ?? String(err)}`;
    }
  }

  private async checkRedis(): Promise<string | null> {
    try {
      await this.orderQueue.client.ping();
      this.logger.log("Redis/queue connection: OK");
      return null;
    } catch (err: any) {
      return `Redis connection failed: ${err?.message ?? String(err)}`;
    }
  }
}
