import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { QUEUES, ORDER_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

const BATCH_SIZE = 50;
const MAX_BACKOFF_SECONDS = 3600;

// Events stuck in PROCESSING for longer than this are recovered to PENDING/DEAD.
// Override with OUTBOX_PROCESSING_TIMEOUT_SECONDS env var.
const DEFAULT_PROCESSING_TIMEOUT_SECONDS = 300; // 5 minutes

@Injectable()
export class OutboxDispatcherCron {
  private readonly logger = new Logger(OutboxDispatcherCron.name);
  private running = false;
  private readonly processingTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
  ) {
    this.processingTimeoutMs =
      parseInt(process.env.OUTBOX_PROCESSING_TIMEOUT_SECONDS ?? String(DEFAULT_PROCESSING_TIMEOUT_SECONDS), 10) * 1000;
  }

  @Cron("*/5 * * * * *") // every 5 seconds
  async dispatch(): Promise<void> {
    // Prevent re-entrant execution if a previous tick is still running
    if (this.running) return;
    this.running = true;

    try {
      await this.processBatch();
    } catch (err: any) {
      this.logger.error(`Outbox dispatcher error: ${err.message}`, err.stack);
    } finally {
      this.running = false;
    }
  }

  private async processBatch(): Promise<void> {
    // Recover any events that got stuck in PROCESSING (e.g. process crash mid-dispatch).
    // Run before claiming new events so recovered events are eligible for immediate retry.
    await this.recoverStuckProcessing();

    // Atomically claim up to BATCH_SIZE pending events using SELECT FOR UPDATE SKIP LOCKED.
    // This is safe under concurrent API instances — each instance claims its own subset.
    const now = new Date();
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE outbox_events
      SET status = 'PROCESSING', "updatedAt" = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING'
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    if (claimed.length === 0) return;

    this.logger.debug(`Outbox: claimed ${claimed.length} event(s)`);

    const events = await this.prisma.outboxEvent.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
    });

    await Promise.allSettled(
      events.map((event) => this.processOne(event)),
    );
  }

  private async processOne(event: {
    id: string;
    eventType: string;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
  }): Promise<void> {
    try {
      await this.dispatch_event(event.eventType, event.payload as Record<string, unknown>);

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
    } catch (err: any) {
      const nextAttempt = event.attempts + 1;
      const isDead = nextAttempt >= event.maxAttempts;

      const backoffSeconds = Math.min(
        30 * Math.pow(4, event.attempts),
        MAX_BACKOFF_SECONDS,
      );
      const nextAttemptAt = isDead
        ? null
        : new Date(Date.now() + backoffSeconds * 1000);

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: isDead ? "DEAD" : "FAILED",
          attempts: { increment: 1 },
          lastError: String(err.message ?? err),
          nextAttemptAt,
        },
      });

      this.logger.warn(
        `Outbox event ${event.id} (${event.eventType}) failed ` +
          `(attempt ${nextAttempt}/${event.maxAttempts}): ${err.message}`,
      );
    }
  }

  private async dispatch_event(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (eventType) {
      case "order.received":
        await this.orderQueue.add(
          ORDER_JOBS.INGEST,
          { orderId: payload["orderId"], tenantId: payload["tenantId"], locationId: payload["locationId"] },
          { jobId: `ingest-${payload["orderId"]}` },
        );
        break;

      case "order.status_changed":
        await this.orderQueue.add(
          ORDER_JOBS.STATUS_CHANGE,
          {
            orderId: payload["orderId"],
            tenantId: payload["tenantId"],
            locationId: payload["locationId"],
            fromStatus: payload["fromStatus"],
            toStatus: payload["toStatus"],
            cancelReason: payload["cancelReason"],
          },
          {
            jobId: `status-${payload["orderId"]}-${payload["toStatus"]}`,
            attempts: 5,
            backoff: { type: "rate-limit-aware", delay: 3000 },
          },
        );
        break;

      default:
        this.logger.warn(`Unknown outbox event type: ${eventType} — skipping`);
    }
  }

  /**
   * Find PROCESSING events that have been stuck longer than processingTimeoutMs
   * and recover them to PENDING (with backoff) or DEAD (if maxAttempts exhausted).
   * Uses SELECT FOR UPDATE SKIP LOCKED so multiple API instances never double-recover.
   */
  private async recoverStuckProcessing(): Promise<void> {
    const cutoffAt = new Date(Date.now() - this.processingTimeoutMs);

    const stuck = await this.prisma.$queryRaw<
      Array<{ id: string; attempts: number; maxAttempts: number }>
    >`
      SELECT id, attempts, "maxAttempts" FROM outbox_events
      WHERE status = 'PROCESSING' AND "updatedAt" < ${cutoffAt}
      FOR UPDATE SKIP LOCKED
    `;

    if (stuck.length === 0) return;

    const timeoutSeconds = this.processingTimeoutMs / 1000;
    this.logger.warn(`Outbox: recovering ${stuck.length} stuck PROCESSING event(s) (timeout=${timeoutSeconds}s)`);

    for (const event of stuck) {
      const nextAttempt = event.attempts + 1;
      const isDead = nextAttempt >= event.maxAttempts;
      const backoffSeconds = Math.min(30 * Math.pow(4, event.attempts), MAX_BACKOFF_SECONDS);
      const nextAttemptAt = isDead ? null : new Date(Date.now() + backoffSeconds * 1000);
      const newStatus = isDead ? "DEAD" : "PENDING";

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: newStatus,
          attempts: { increment: 1 },
          lastError: `Stuck in PROCESSING for >${timeoutSeconds}s — recovered by housekeeping`,
          nextAttemptAt,
          updatedAt: new Date(),
        },
      });

      this.logger.warn(
        `Outbox: recovered stuck event ${event.id} → ${newStatus} ` +
          `(attempt ${nextAttempt}/${event.maxAttempts})`,
      );
    }
  }

  /** Exposed for testing and monitoring: returns pending/failed/dead counts. */
  async getStats(): Promise<{
    pending: number;
    processing: number;
    stuckProcessing: number;
    failed: number;
    dead: number;
    oldestPendingAgeMs: number | null;
    lastRecoveredAt: Date | null;
  }> {
    const cutoffAt = new Date(Date.now() - this.processingTimeoutMs);

    const [pending, processing, stuckProcessing, failed, dead, oldest, lastRecovered] =
      await Promise.all([
        this.prisma.outboxEvent.count({ where: { status: "PENDING" } }),
        this.prisma.outboxEvent.count({ where: { status: "PROCESSING" } }),
        this.prisma.outboxEvent.count({
          where: { status: "PROCESSING", updatedAt: { lt: cutoffAt } },
        }),
        this.prisma.outboxEvent.count({ where: { status: "FAILED" } }),
        this.prisma.outboxEvent.count({ where: { status: "DEAD" } }),
        this.prisma.outboxEvent.findFirst({
          where: { status: { in: ["PENDING", "FAILED"] } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        this.prisma.outboxEvent.findFirst({
          where: {
            status: { in: ["PENDING", "DEAD"] },
            lastError: { contains: "recovered by housekeeping" },
          },
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        }),
      ]);

    return {
      pending,
      processing,
      stuckProcessing,
      failed,
      dead,
      oldestPendingAgeMs: oldest ? Date.now() - oldest.createdAt.getTime() : null,
      lastRecoveredAt: lastRecovered?.updatedAt ?? null,
    };
  }
}
