import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../logs/activity-log.service";
import { DeliverooStoreControlAdapter } from "../integrations/deliveroo/deliveroo-store-control.adapter";
import { PauseService } from "./pause.service";
import { REOPEN_LOOKBACK_MS, shouldReopenAfterPause } from "./pause-reopen";

// Reopens Deliveroo sites a timed pause closed and never came back for.
//
// See pause-reopen.ts for why Deliveroo alone needs this: its status call
// carries no end time, so "stop taking orders for an hour" closed the site
// and nothing was ever going to reopen it.
//
// The sweep is driven by the connection row rather than by pause rows:
// setStoreOpen writes status "suspended" when it closes a site and
// "connected" when it opens one, so a reopened site drops out of the query
// by itself, and a site whose reopen FAILED is picked up again next minute
// instead of being quietly marked done.

@Injectable()
export class PauseReopenCron {
  private readonly logger = new Logger(PauseReopenCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveroo: DeliverooStoreControlAdapter,
    private readonly pauses: PauseService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    try {
      const now = new Date();
      const closed = await this.prisma.brandPlatformConnection.findMany({
        where: {
          platform: "DELIVEROO",
          status: "suspended",
          externalStoreId: { not: null },
        },
        select: {
          id: true,
          tenantId: true,
          brandId: true,
          locationId: true,
          updatedAt: true,
          externalStoreId: true,
        },
      });
      if (closed.length === 0) return;

      for (const conn of closed) {
        try {
          const snap = await this.pauses.isPaused({
            locationId: conn.locationId,
            brandId: conn.brandId,
            channel: "DELIVEROO" as any,
          });

          // Pauses covering this site that have already ended. A row with a
          // null brandId or channel covers everything at the location, which
          // is how "pause the whole shop" is stored.
          const expired = await (this.prisma as any).channelPause.findMany({
            where: {
              locationId: conn.locationId,
              resumeAt: {
                not: null,
                lte: now,
                gte: new Date(now.getTime() - REOPEN_LOOKBACK_MS),
              },
              AND: [
                { OR: [{ brandId: null }, { brandId: conn.brandId }] },
                { OR: [{ channel: null }, { channel: "DELIVEROO" }] },
              ],
            },
            select: { resumeAt: true },
          });

          const reopen = shouldReopenAfterPause(
            {
              connectionUpdatedAt: conn.updatedAt,
              expiredResumeAts: expired
                .map((r: { resumeAt: Date | null }) => r.resumeAt)
                .filter((d: Date | null): d is Date => !!d),
              stillPaused: snap.paused,
            },
            now,
          );
          if (!reopen) continue;

          await this.deliveroo.setStoreOpen(conn.tenantId, conn.id, true);
          this.logger.log(
            `Deliveroo site ${conn.externalStoreId} reopened — its pause ended and nothing else is keeping it closed`,
          );
          this.activity?.record({
            tenantId: conn.tenantId,
            locationId: conn.locationId,
            brandId: conn.brandId,
            category: "STATUS",
            channel: "DELIVEROO",
            action: "store.resume",
            status: "SUCCESS",
            message: `Deliveroo site ${conn.externalStoreId} reopened automatically when its pause ended`,
            details: { storeId: conn.externalStoreId },
          });
        } catch (err: any) {
          // Left suspended on purpose: the next run tries again, which is
          // the whole point of driving this off the connection's status.
          this.logger.warn(
            `Reopening Deliveroo site ${conn.externalStoreId} failed, will retry: ${err?.message ?? err}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`Pause reopen sweep failed: ${err?.message ?? err}`);
    }
  }
}
