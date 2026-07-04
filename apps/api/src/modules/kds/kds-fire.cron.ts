// Phase KD — fires scheduled orders onto the kitchen screens when their
// slot approaches (scheduled time − prep − buffer). Runs every minute; an
// order is due when it's ACCEPTED, scheduled, has no tickets yet, and its
// location actually has active screens.

import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { KdsService } from "./kds.service";
import { KdsDispatchService } from "./kds-dispatch.service";

@Injectable()
export class KdsFireCron {
  private readonly logger = new Logger(KdsFireCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kds: KdsService,
    private readonly dispatch: KdsDispatchService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async fireDueScheduledOrders(): Promise<void> {
    if (this.running) return; // skip overlapping ticks
    this.running = true;
    try {
      const candidates = await this.prisma.order.findMany({
        where: {
          status: "ACCEPTED",
          scheduledFor: { not: null },
          kdsTickets: { none: {} },
          location: { kdsScreens: { some: { isActive: true } } },
        },
        select: {
          id: true,
          locationId: true,
          scheduledFor: true,
          location: { select: { prepTime: true } },
        },
        take: 200,
      });
      const now = Date.now();
      for (const order of candidates) {
        const fireAt =
          order.scheduledFor!.getTime() - this.dispatch.leadMs(order);
        if (fireAt > now) continue;
        await this.kds.dispatchOrderToScreens(order.id, order.locationId);
        this.logger.log(
          `KDS: fired scheduled order ${order.id} (slot ${order.scheduledFor!.toISOString()})`,
        );
      }
    } catch (err: any) {
      this.logger.error(`KDS fire cron failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
