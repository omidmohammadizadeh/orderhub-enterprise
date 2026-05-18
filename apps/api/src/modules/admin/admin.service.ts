import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue, Job } from "bull";
import { QUEUES, ORDER_JOBS, PRINT_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface JobSummary {
  id: string | number;
  name: string;
  status: string;
  data: unknown;
  attemptsMade: number;
  maxAttempts: number;
  failedReason?: string;
  stacktrace?: string[];
  processedOn?: number;
  finishedOn?: number;
  timestamp: number;
}

export interface QueueStats {
  queue: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
    @InjectQueue(QUEUES.ORDER_SYNC) private readonly syncQueue: Queue,
    @InjectQueue(QUEUES.PRINTING) private readonly printQueue: Queue,
  ) {}

  // ── Webhook Event Viewer ───────────────────────────────

  async getWebhookEvents(filters: {
    tenantId?: string;
    platform?: string;
    hasError?: boolean;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }) {
    const { tenantId, platform, hasError, from, to, page = 1, limit = 50 } = filters;

    const where: any = {
      ...(tenantId && { tenantId }),
      ...(platform && { platform }),
      ...(hasError !== undefined && {
        processingError: hasError ? { not: null } : null,
      }),
      ...(from || to
        ? { receivedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }
        : {}),
    };

    const [total, events] = await Promise.all([
      this.prisma.webhookEvent.count({ where }),
      this.prisma.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          platform: true,
          tenantId: true,
          locationId: true,
          externalEventId: true,
          retryCount: true,
          receivedAt: true,
          processedAt: true,
          processingError: true,
          orderId: true,
        },
      }),
    ]);

    return { total, page, limit, events };
  }

  async replayWebhookEvent(eventId: string): Promise<{ queued: boolean }> {
    const event = await this.prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (!event) return { queued: false };

    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: { retryCount: { increment: 1 }, processingError: null },
    });

    // TODO: Enqueue for reprocessing via WEBHOOK_DISPATCH queue
    this.logger.log(`Webhook event ${eventId} queued for replay`);
    return { queued: true };
  }

  // ── Queue Inspector ────────────────────────────────────

  async getQueueStats(): Promise<QueueStats[]> {
    const queues = [
      { name: QUEUES.ORDER_PROCESSING, queue: this.orderQueue },
      { name: QUEUES.ORDER_SYNC, queue: this.syncQueue },
      { name: QUEUES.PRINTING, queue: this.printQueue },
    ];

    const stats: QueueStats[] = [];
    for (const { name, queue } of queues) {
      const counts = await queue.getJobCounts();
      const isPaused = await queue.isPaused();
      stats.push({
        queue: name,
        waiting: counts.waiting,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
        delayed: counts.delayed,
        paused: isPaused,
      });
    }

    return stats;
  }

  async getFailedJobs(queueName: string, limit = 50): Promise<JobSummary[]> {
    const queue = this.resolveQueue(queueName);
    if (!queue) return [];

    const jobs = await queue.getFailed(0, limit - 1);
    return jobs.map(this.toJobSummary);
  }

  async getActiveJobs(queueName: string): Promise<JobSummary[]> {
    const queue = this.resolveQueue(queueName);
    if (!queue) return [];

    const jobs = await queue.getActive();
    return jobs.map(this.toJobSummary);
  }

  async retryFailedJob(queueName: string, jobId: string): Promise<{ retried: boolean }> {
    const queue = this.resolveQueue(queueName);
    if (!queue) return { retried: false };

    const job = await queue.getJob(jobId);
    if (!job) return { retried: false };

    await job.retry();
    this.logger.log(`Retried job ${jobId} on queue ${queueName}`);
    return { retried: true };
  }

  async retryAllFailedJobs(queueName: string): Promise<{ count: number }> {
    const queue = this.resolveQueue(queueName);
    if (!queue) return { count: 0 };

    const failed = await queue.getFailed();
    let count = 0;
    for (const job of failed) {
      try {
        await job.retry();
        count++;
      } catch {
        // job may have already been cleaned up
      }
    }
    this.logger.log(`Retried ${count} failed jobs on queue ${queueName}`);
    return { count };
  }

  async discardJob(queueName: string, jobId: string): Promise<{ discarded: boolean }> {
    const queue = this.resolveQueue(queueName);
    if (!queue) return { discarded: false };

    const job = await queue.getJob(jobId);
    if (!job) return { discarded: false };

    await job.discard();
    await job.remove();
    return { discarded: true };
  }

  // ── Print Queue Viewer ─────────────────────────────────

  async getPrintQueue(filters: {
    tenantId?: string;
    locationId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const { tenantId, locationId, status, page = 1, limit = 50 } = filters;

    const where: any = {
      ...(tenantId && { tenantId }),
      ...(locationId && { locationId }),
      ...(status && { status }),
    };

    const [total, jobs] = await Promise.all([
      this.prisma.printJob.count({ where }),
      this.prisma.printJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          tenantId: true,
          locationId: true,
          orderId: true,
          printerId: true,
          type: true,
          status: true,
          attempts: true,
          error: true,
          createdAt: true,
          printedAt: true,
          printer: { select: { name: true, type: true } },
        },
      }),
    ]);

    return { total, page, limit, jobs };
  }

  // ── Integration Health Monitor ─────────────────────────

  async getIntegrationHealth(tenantId?: string) {
    const integrations = await this.prisma.integration.findMany({
      where: {
        ...(tenantId && { tenantId }),
        deletedAt: null,
      },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        platform: true,
        status: true,
        lastSyncAt: true,
        lastErrorAt: true,
        lastError: true,
        location: { select: { name: true, brandId: true } },
      },
      orderBy: [{ tenantId: "asc" }, { platform: "asc" }],
    });

    return integrations.map((i) => ({
      ...i,
      healthStatus: this.deriveIntegrationHealth(i),
    }));
  }

  private deriveIntegrationHealth(
    integration: { status: string; lastErrorAt: Date | null; lastSyncAt: Date | null },
  ): "healthy" | "degraded" | "error" | "unknown" {
    if (integration.status !== "ACTIVE") return "unknown";
    if (integration.lastErrorAt) {
      const hoursSinceError =
        (Date.now() - integration.lastErrorAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceError < 1) return "error";
      if (hoursSinceError < 24) return "degraded";
    }
    if (!integration.lastSyncAt) return "unknown";
    return "healthy";
  }

  // ── Location Health Status ─────────────────────────────

  async getLocationHealth(tenantId?: string) {
    const locations = await this.prisma.location.findMany({
      where: {
        ...(tenantId && { brand: { tenantId } }),
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        brand: { select: { tenantId: true, name: true } },
        printers: {
          where: { deletedAt: null },
          select: { id: true, isOnline: true, type: true },
        },
        integrations: {
          where: { deletedAt: null, status: "ACTIVE" },
          select: { id: true, platform: true, status: true, lastErrorAt: true },
        },
        _count: {
          select: {
            orders: {
              where: { status: { in: ["PENDING", "ACCEPTED", "PREPARING", "READY"] } },
            },
          },
        },
      },
    });

    return locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      tenantId: loc.brand.tenantId,
      brandName: loc.brand.name,
      activeOrders: loc._count.orders,
      printersOnline: loc.printers.filter((p) => p.isOnline).length,
      printersTotal: loc.printers.length,
      integrationsHealthy: loc.integrations.filter((i) => !i.lastErrorAt).length,
      integrationsTotal: loc.integrations.length,
    }));
  }

  // ── Helpers ────────────────────────────────────────────

  private resolveQueue(name: string): Queue | undefined {
    const map: Record<string, Queue> = {
      [QUEUES.ORDER_PROCESSING]: this.orderQueue,
      [QUEUES.ORDER_SYNC]: this.syncQueue,
      [QUEUES.PRINTING]: this.printQueue,
    };
    return map[name];
  }

  private toJobSummary = (job: Job): JobSummary => ({
    id: job.id,
    name: job.name,
    status: "failed",
    data: job.data,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 3,
    failedReason: job.failedReason,
    stacktrace: job.stacktrace,
    processedOn: job.processedOn ?? undefined,
    finishedOn: job.finishedOn ?? undefined,
    timestamp: job.timestamp,
  });
}
