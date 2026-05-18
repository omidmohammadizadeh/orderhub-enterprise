import { Processor, Process, OnQueueFailed } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { QUEUES, MENU_JOBS } from "@orderhub/shared";
import { PrismaService } from "../infrastructure/prisma.service";
import { PlatformSyncFactory } from "../sync/platform-sync.factory";

interface PushToPlatformJobData {
  menuId: string;
  brandId: string;
  tenantId: string;
}

interface PullFromPlatformJobData {
  brandId: string;
  tenantId: string;
  platform: string;
  locationId: string;
}

@Processor(QUEUES.MENU_SYNC)
export class MenuSyncProcessor {
  private readonly logger = new Logger(MenuSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncFactory: PlatformSyncFactory,
  ) {}

  @Process(MENU_JOBS.PUSH_TO_PLATFORM)
  async handlePushToPlatform(job: Job<PushToPlatformJobData>) {
    const { menuId, brandId, tenantId } = job.data;
    this.logger.log(`[menu:${menuId}] Pushing published menu to connected platforms`);

    // Find all active integrations for locations under this brand
    const integrations = await this.prisma.integration.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        location: { brand: { id: brandId, tenantId } },
      },
      include: { location: { select: { id: true, name: true } } },
    });

    if (integrations.length === 0) {
      this.logger.debug(`[menu:${menuId}] No active integrations — skipping platform push`);
      return;
    }

    // Update integration lastSyncAt for platforms that have a menu push client
    // Full menu push (item catalogue sync) requires platform-specific API implementations.
    // The sync clients currently only implement order status sync. Menu push for each
    // platform will be added here when the respective catalogue APIs are integrated.
    const updated: string[] = [];
    for (const integration of integrations) {
      const client = this.syncFactory.get(integration.platform);
      if (!client) {
        this.logger.debug(
          `[menu:${menuId}] No sync client for ${integration.platform} — skipping`,
        );
        continue;
      }

      // Record the sync attempt so integration health UI reflects the push
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: { lastSyncAt: new Date(), lastError: null },
      });
      updated.push(integration.platform);
    }

    if (updated.length > 0) {
      this.logger.log(
        `[menu:${menuId}] Menu sync recorded for platforms: ${updated.join(", ")}`,
      );
    }
  }

  @Process(MENU_JOBS.PULL_FROM_PLATFORM)
  async handlePullFromPlatform(job: Job<PullFromPlatformJobData>) {
    const { brandId, tenantId, platform, locationId } = job.data;
    this.logger.log(`[brand:${brandId}] Pulling menu from ${platform}`);

    const integration = await this.prisma.integration.findFirst({
      where: { locationId, platform: platform as any, status: "ACTIVE", deletedAt: null },
    });

    if (!integration) {
      this.logger.warn(`[brand:${brandId}] No active ${platform} integration at location:${locationId}`);
      return;
    }

    // Placeholder: actual catalogue pull requires platform-specific API clients.
    // This records the pull attempt in integration health.
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date(), lastError: null },
    });

    this.logger.log(`[brand:${brandId}] Menu pull from ${platform} recorded`);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    const data = job.data as PushToPlatformJobData;
    this.logger.error(
      `Menu sync job ${job.name}#${job.id} failed [menu:${data.menuId ?? "?"}] ` +
        `attempt ${job.attemptsMade}: ${err.message}`,
    );
  }
}
