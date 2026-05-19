import { Controller, Get, Query } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import { QUEUES } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OutboxDispatcherCron } from "../outbox/outbox-dispatcher.cron";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  version: string;
  environment: string;
  uptime: number;
  timestamp: string;
  checks: Record<string, { status: "ok" | "degraded" | "down"; latencyMs?: number; detail?: string }>;
}

@ApiTags("Health")
@BillingExempt() // Health checks must always be accessible regardless of billing state
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outboxDispatcher: OutboxDispatcherCron,
    private readonly encryption: CredentialEncryptionService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: "Basic liveness check — returns 200 if the process is alive" })
  liveness(): { status: "ok"; timestamp: string } {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  @Public()
  @ApiOperation({ summary: "Readiness probe — checks DB and Redis connectivity before serving traffic" })
  async readiness(): Promise<HealthStatus> {
    const checks: HealthStatus["checks"] = {};
    let overallStatus: HealthStatus["status"] = "ok";

    // ── Database check ───────────────────────────────────
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err: any) {
      checks.database = { status: "down", detail: err?.message };
      overallStatus = "down";
    }

    // ── Redis / queue check ──────────────────────────────
    const redisStart = Date.now();
    try {
      await this.orderQueue.client.ping();
      checks.redis = { status: "ok", latencyMs: Date.now() - redisStart };
    } catch (err: any) {
      checks.redis = { status: "degraded", detail: err?.message };
      if (overallStatus === "ok") overallStatus = "degraded";
    }

    return {
      status: overallStatus,
      version: process.env.npm_package_version ?? "0.0.0",
      environment: this.config.get<string>("app.nodeEnv") ?? "unknown",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  @Get("live")
  @Public()
  @ApiOperation({ summary: "Kubernetes liveness probe endpoint" })
  kubeLiveness(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("release-readiness")
  @ApiOperation({ summary: "Release readiness check for a specific tenant/location" })
  async releaseReadiness(
    @Query("tenantId") tenantId: string,
    @Query("locationId") locationId?: string,
  ): Promise<Record<string, unknown>> {
    const checks: Record<string, unknown> = {};
    const warnings: string[] = [];

    // Environment
    const nodeEnv = this.config.get<string>("app.nodeEnv") ?? "unknown";
    checks.environment = nodeEnv;
    if (nodeEnv !== "production") warnings.push("NODE_ENV is not production");

    // Sandbox guard
    checks.sandboxEnabled = nodeEnv !== "production";
    if (nodeEnv !== "production") warnings.push("Sandbox tools are ENABLED — disable before go-live");

    // ── Encryption key ───────────────────────────────────
    const encryptionKeySet = !!(
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ?? process.env.CREDENTIAL_ENCRYPTION_KEY
    );
    checks.encryption = {
      keySet: encryptionKeySet,
      keyId: this.encryption.keyId,
      previousKeyConfigured: this.encryption.hasPreviousKey,
    };
    if (!encryptionKeySet) warnings.push("CREDENTIAL_ENCRYPTION_KEY is not set — credentials stored in plaintext");

    // ── Database ─────────────────────────────────────────
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch { checks.database = "DOWN"; warnings.push("Database connection failed"); }

    // ── Redis ────────────────────────────────────────────
    try {
      await this.orderQueue.client.ping();
      checks.redis = "ok";
    } catch { checks.redis = "degraded"; warnings.push("Redis/queue unreachable"); }

    if (!tenantId) {
      return { checks, warnings, readyScore: 0 };
    }

    // ── Credential encryption status ─────────────────────
    if (encryptionKeySet) {
      try {
        const rows = await this.prisma.integration.findMany({
          where: { tenantId, deletedAt: null },
          select: { credentials: true },
        });
        const credentialBlobs = rows.map((r) => r.credentials);
        const plaintextCount = this.encryption.countPlaintext(credentialBlobs);
        const oldKeyCount = this.encryption.countOldKey(credentialBlobs);
        const currentKeyCount = this.encryption.countCurrentKey(credentialBlobs);
        checks.credentialEncryption = {
          plaintextCredentials: plaintextCount,
          encryptedWithCurrentKey: currentKeyCount,
          encryptedWithOldKey: oldKeyCount,
        };
        if (plaintextCount > 0) {
          warnings.push(`${plaintextCount} integration(s) still have plaintext credentials — run backfill script`);
        }
        if (oldKeyCount > 0 && !this.encryption.hasPreviousKey) {
          warnings.push(`${oldKeyCount} integration(s) encrypted with unknown old key`);
        }
      } catch { checks.credentialEncryption = "unavailable"; }
    }

    // ── Outbox health ─────────────────────────────────────
    try {
      const s = await this.outboxDispatcher.getStats();
      checks.outbox = {
        pending: s.pending,
        processing: s.processing,
        stuckProcessing: s.stuckProcessing,
        failed: s.failed,
        dead: s.dead,
        oldestPendingAgeMs: s.oldestPendingAgeMs,
        lastRecoveredAt: s.lastRecoveredAt?.toISOString() ?? null,
      };
      if (s.dead > 0) warnings.push(`${s.dead} dead outbox event(s) — manual intervention required`);
      if (s.stuckProcessing > 0) warnings.push(`${s.stuckProcessing} outbox event(s) stuck in PROCESSING`);
      if (s.failed > 5) warnings.push(`${s.failed} failed outbox event(s) — check dispatcher logs`);
      if (s.oldestPendingAgeMs !== null && s.oldestPendingAgeMs > 5 * 60_000) {
        warnings.push("Outbox has events older than 5 minutes — dispatcher may be stalled");
      }
    } catch { checks.outbox = "unavailable"; }

    // ── Webhook health ─────────────────────────────────────
    try {
      const platforms = ["UBER_EATS", "DELIVEROO", "JUST_EAT", "HUBRISE"] as const;
      const webhookHealth: Record<string, unknown> = {};

      for (const platform of platforms) {
        const [lastSuccess, lastFailed, failedCount, duplicateCount] = await Promise.all([
          this.prisma.webhookEvent.findFirst({
            where: { platform, processedAt: { not: null } },
            orderBy: { processedAt: "desc" },
            select: { processedAt: true },
          }),
          this.prisma.webhookEvent.findFirst({
            where: { platform, processingError: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true, processingError: true },
          }),
          this.prisma.webhookEvent.count({
            where: {
              platform,
              processingError: { not: null },
              createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
            },
          }),
          this.prisma.webhookEvent.count({
            where: {
              platform,
              processedAt: null,
              processingError: null,
            },
          }),
        ]);
        webhookHealth[platform] = {
          lastSuccessAt: lastSuccess?.processedAt?.toISOString() ?? null,
          lastFailedAt: lastFailed?.createdAt?.toISOString() ?? null,
          failedLast24h: failedCount,
          duplicatesIgnored: duplicateCount,
        };
      }
      checks.webhooks = webhookHealth;
    } catch { checks.webhooks = "unavailable"; }

    // ── Active integrations ──────────────────────────────
    const integrations = await this.prisma.integration.findMany({
      where: { location: { brand: { tenantId } }, status: "ACTIVE" },
      select: { platform: true, status: true, locationId: true },
    });
    checks.activeIntegrations = integrations.map((i) => i.platform);

    // ── Printers ─────────────────────────────────────────
    const printerWhere: any = { location: { brand: { tenantId } } };
    if (locationId) printerWhere.locationId = locationId;
    const printers = await this.prisma.printer.findMany({
      where: printerWhere,
      select: { id: true, isOnline: true, isActive: true, name: true },
    });
    const activePrinters = printers.filter((p) => p.isActive);
    checks.printersOnline = activePrinters.filter((p) => p.isOnline).length;
    checks.printersOffline = activePrinters.filter((p) => !p.isOnline).length;
    if (activePrinters.length === 0) warnings.push("No active printers configured");
    if (activePrinters.some((p) => !p.isOnline)) warnings.push("Some printers are offline");

    // ── Failed print jobs ────────────────────────────────
    const failedPrintJobs = await this.prisma.printJob.count({
      where: {
        ...(locationId ? { locationId } : {}),
        tenantId,
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
      },
    });
    checks.failedPrintJobsLast24h = failedPrintJobs;
    if (failedPrintJobs > 5) warnings.push(`${failedPrintJobs} failed print jobs in last 24h`);

    // ── Queue stats ──────────────────────────────────────
    try {
      const [waiting, active, failed] = await Promise.all([
        this.orderQueue.getWaitingCount(),
        this.orderQueue.getActiveCount(),
        this.orderQueue.getFailedCount(),
      ]);
      checks.queueWaiting = waiting;
      checks.queueActive = active;
      checks.queueFailed = failed;
      if (failed > 10) warnings.push(`${failed} failed queue jobs — check worker`);
    } catch { checks.queueStats = "unavailable"; }

    // ── Last successful order ────────────────────────────
    const lastOrder = await this.prisma.order.findFirst({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, platform: true },
    });
    checks.lastOrderAt = lastOrder?.createdAt.toISOString() ?? null;
    checks.lastOrderPlatform = lastOrder?.platform ?? null;

    const readyScore = Math.max(0, 100 - warnings.length * 10);
    return { checks, warnings, readyScore, generatedAt: new Date().toISOString() };
  }
}
