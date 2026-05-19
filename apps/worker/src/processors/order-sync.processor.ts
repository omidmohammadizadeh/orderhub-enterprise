import { Processor, Process, OnQueueFailed } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import type { OrderStatus } from "@orderhub/database";
import { QUEUES, ORDER_JOBS } from "@orderhub/shared";
import { PrismaService } from "../infrastructure/prisma.service";
import { PlatformSyncFactory } from "../sync/platform-sync.factory";
import { TokenRefreshService } from "../sync/token-refresh.service";

interface SyncStatusJobData {
  orderId: string;
  tenantId: string;
  locationId: string;
  toStatus: string;
  cancelReason?: string;
}

@Processor(QUEUES.ORDER_SYNC)
export class OrderSyncProcessor {
  private readonly logger = new Logger(OrderSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncFactory: PlatformSyncFactory,
    private readonly tokenRefresh: TokenRefreshService,
  ) {}

  @Process(ORDER_JOBS.SYNC_STATUS)
  async handleSyncStatus(job: Job<SyncStatusJobData>) {
    const { orderId, toStatus, cancelReason } = job.data;

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      this.logger.warn(`[${orderId}] Order not found — sync skipped`);
      return;
    }

    // DIRECT / POS / ONLINE orders have no external platform to sync to
    if (["DIRECT", "POS", "ONLINE"].includes(order.platform)) {
      return;
    }

    // Resolve credentials from Integration record
    const integration = await this.prisma.integration.findFirst({
      where: {
        locationId: order.locationId,
        platform: order.platform as any,
        status: "ACTIVE",
      },
    });

    if (!integration) {
      this.logger.debug(
        `[${orderId}] No active integration for ${order.platform}/${order.locationId} — sync skipped`,
      );
      return;
    }

    if (!order.externalId) {
      this.logger.warn(`[${orderId}] No externalId for platform order — cannot sync`);
      return;
    }

    // If order came via HubRise, sync to HubRise regardless of origin platform
    const syncPlatform = order.viaHubrise ? "HUBRISE" : order.platform;
    const client = this.syncFactory.get(syncPlatform);
    if (!client) {
      this.logger.warn(`[${orderId}] No sync client for platform: ${syncPlatform}`);
      return;
    }

    // Get fresh credentials — refreshes OAuth token if expiring within 5 minutes
    const credentials = await this.tokenRefresh.getCredentials(integration.id);
    const result = await client.syncStatus(
      order.externalId,
      toStatus as OrderStatus,
      credentials,
      { cancelReason },
    );

    if (result.success) {
      this.logger.log(
        `[${orderId}] Status synced to ${syncPlatform}: ${toStatus}`,
      );
    } else if (result.rateLimited) {
      const retryInfo = result.retryAfterMs != null
        ? `Retry-After: ${result.retryAfterMs}ms`
        : "no Retry-After header";
      this.logger.warn(
        `[${orderId}] Rate limited by ${syncPlatform} (${retryInfo}) — Bull will retry with exponential backoff`,
      );
      // Throw so Bull records the failure and schedules the next retry via its backoff config
      throw new Error(`RATE_LIMITED by ${syncPlatform}: ${retryInfo}`);
    } else {
      // Throw to trigger Bull retry
      throw new Error(
        `[${orderId}] Sync to ${syncPlatform} failed: ${result.error}`,
      );
    }
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    const data = job.data as SyncStatusJobData;
    const isRateLimit = err.message.startsWith("RATE_LIMITED");
    if (isRateLimit) {
      this.logger.warn(
        `Sync job rate-limited [${data.orderId}] attempt ${job.attemptsMade}/${job.opts.attempts} — ${err.message}`,
      );
    } else {
      this.logger.error(
        `Sync job failed [${data.orderId}] attempt ${job.attemptsMade}/${job.opts.attempts}: ${err.message}`,
      );
    }
    // After maxAttempts the job lands in the failed set (Dead Letter Queue).
    // Use Bull Board or manual inspection to handle DLQ entries.
  }
}
