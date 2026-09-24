import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "./orders.service";
import { nextAutoStatus, readAutoReadySettings } from "./auto-ready";

// Runs every minute and advances accepted orders to Preparing, then Ready,
// for shops that switched Auto ready on. See auto-ready.ts for the rule.
//
// Everything goes through OrdersService.updateStatus with actorType SYSTEM,
// so it behaves exactly as if the operator had tapped the button: Deliveroo
// gets its prep_stage, Uber gets /ready, the kitchen screen bumps, the
// customer is notified, and the board updates live over the socket. Nothing
// here talks to a marketplace directly.

/** Orders older than this are the 5am rollover's problem, not ours. */
const LOOKBACK_HOURS = 24;

@Injectable()
export class OrdersAutoReadyCron {
  private readonly logger = new Logger(OrdersAutoReadyCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    const now = new Date();
    try {
      // Shops with the timer on first: on most tenants that is a short list,
      // and it keeps the order scan to those locations.
      const locations = await this.prisma.location.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, settings: true },
      });
      const configured = new Map(
        locations
          .map((l) => [l.id, readAutoReadySettings(l.settings)] as const)
          .filter((entry): entry is [string, NonNullable<ReturnType<typeof readAutoReadySettings>>] =>
            entry[1] !== null,
          ),
      );
      if (configured.size === 0) return;

      const orders = await this.prisma.order.findMany({
        where: {
          locationId: { in: Array.from(configured.keys()) },
          status: { in: ["ACCEPTED", "PREPARING"] as any },
          createdAt: { gte: new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000) },
        },
        select: {
          id: true,
          tenantId: true,
          locationId: true,
          displayId: true,
          status: true,
          acceptedAt: true,
          createdAt: true,
          scheduledFor: true,
          orderSource: true,
          platform: true,
          fulfillmentType: true,
        },
      });

      let moved = 0;
      for (const order of orders) {
        const next = nextAutoStatus(order as any, configured.get(order.locationId)!, now);
        if (!next) continue;
        try {
          await this.orders.updateStatus(
            order.id,
            order.tenantId,
            { status: next } as any,
            "system:auto-ready",
            "SYSTEM",
          );
          moved++;
          this.logger.log(
            `Auto ready: order ${order.displayId ?? order.id} ${order.status} → ${next} ` +
              `(location ${order.locationId})`,
          );
        } catch (err: any) {
          // One order failing (a status the state machine refuses, a
          // marketplace push erroring) must not stop the rest of the run.
          this.logger.warn(
            `Auto ready: order ${order.displayId ?? order.id} → ${next} failed: ${err?.message ?? err}`,
          );
        }
      }
      if (moved > 0) {
        this.logger.log(`Auto ready: advanced ${moved} order(s) across ${configured.size} location(s)`);
      }
    } catch (err: any) {
      this.logger.error(`Auto ready cron failed: ${err?.message ?? err}`);
    }
  }
}
