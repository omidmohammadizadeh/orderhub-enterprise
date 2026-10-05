import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { DeliverooOrderSyncService } from "./deliveroo-order-sync.service";
import {
  DELIVEROO_CONFIRM_AT_KEY,
  isConfirmDue,
  isDeliverooConfirmed,
} from "./deliveroo-scheduled";

// Confirms scheduled Deliveroo orders that nobody has started yet.
//
// A scheduled order is accepted when it arrives, then has to be CONFIRMED by
// the `confirm_at` Deliveroo puts in the payload. Normally the kitchen moving
// it to Preparing does that (the sync service), but a scheduled order taken at
// noon for 7pm is usually untouched until the evening, so this sweeps them on
// Deliveroo's timetable rather than ours.
//
// Never early: confirming says the site is starting to prepare, so the clock
// is Deliveroo's confirm_at, not our own guess.

/** Far enough back to cover a service, without scanning history. */
const LOOKBACK_HOURS = 48;

@Injectable()
export class DeliverooScheduledConfirmCron {
  private readonly logger = new Logger(DeliverooScheduledConfirmCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: DeliverooOrderSyncService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    try {
      const now = new Date();
      const candidates = await this.prisma.order.findMany({
        where: {
          platform: "DELIVEROO",
          integrationSource: "DIRECT",
          viaHubrise: false,
          externalId: { not: null },
          // Accepted but not yet started: once it is preparing, the sync
          // service has already confirmed it.
          status: "ACCEPTED" as any,
          createdAt: { gte: new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000) },
        },
        select: { id: true, externalId: true, displayId: true, metadata: true },
      });

      const due = candidates.filter(
        (o) => !isDeliverooConfirmed(o.metadata) && isConfirmDue(o.metadata, now),
      );
      if (due.length === 0) return;

      let confirmed = 0;
      for (const order of due) {
        const ok = await this.sync.confirmScheduled(order.id, order.externalId!);
        if (ok) confirmed++;
      }
      this.logger.log(
        `Deliveroo scheduled confirm: ${confirmed}/${due.length} order(s) confirmed at their ${DELIVEROO_CONFIRM_AT_KEY}`,
      );
    } catch (err: any) {
      this.logger.error(`Deliveroo scheduled confirm cron failed: ${err?.message ?? err}`);
    }
  }
}
