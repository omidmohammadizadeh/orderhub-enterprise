import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { ReferralService } from "../loyalty/referral.service";
import { DispatchSettlementService } from "../dispatch/dispatch-settlement.service";

// Phase AW-27 — Auto-complete at the business-day rollover.
//
// The business day ends at 05:00 UTC (≈ 05:00 GMT / 06:00 BST, matching the
// operator's "next shift" cutoff). Every non-terminal order from BEFORE that
// line is flipped to COMPLETED so the next morning starts with a clean board.
//
// Runs hourly, not once at 05:00, because of the grace window below. An order
// placed at 04:50 is skipped by the 05:00 run (it is only ten minutes old) and,
// when this only ran daily, nothing looked at it again until 05:00 the NEXT
// morning — so it sat on the orders board and the dispatch map for another day,
// counting up as an ever-later red pin. The hourly run catches it at 06:00.
//
// The boundary is what keeps this safe: only orders from before the most recent
// 05:00 are ever touched, so an order taken at 09:00 today is never completed
// out from under the shop that is still working on it.
//
// In-scope statuses (anything that can still legitimately progress):
//   PENDING, ACCEPTED, PREPARING, READY, DISPATCHED,
//   PENDING_DISPATCH, ASSIGNED_DRIVER, ACCEPTED_BY_DRIVER,
//   OUT_FOR_DELIVERY
//
// Out-of-scope (already terminal — left untouched):
//   COMPLETED, CANCELLED, REJECTED, FAILED, REFUNDED
//
// It also bounds by `updatedAt` older than an hour, so an order anyone has
// touched recently is left alone. The cron writes a status-history row tagged
// "SYSTEM / 5am-rollover" so the audit trail explains why the status flipped
// without operator input.

@Injectable()
export class OrdersAutoCompleteCron {
  private readonly logger = new Logger(OrdersAutoCompleteCron.name);

  private static readonly IN_FLIGHT_STATUSES = [
    "PENDING",
    "ACCEPTED",
    "PREPARING",
    "READY",
    "DISPATCHED",
    "PENDING_DISPATCH",
    "ASSIGNED_DRIVER",
    "ACCEPTED_BY_DRIVER",
    "OUT_FOR_DELIVERY",
    // Same reason the board needs it: a delivery can legitimately end the
    // night sat in RIDER_ARRIVED (driver slid "arrived" but never
    // "delivered"). Without it here the 5am rollover skipped those and
    // they lingered on the board indefinitely.
    "RIDER_ARRIVED",
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyService,
    private readonly referrals: ReferralService,
    private readonly dispatchSettlement: DispatchSettlementService,
  ) {}

  /** The most recent 05:00 UTC — the line between yesterday's trade and today's. */
  static businessDayBoundary(now: Date): Date {
    const boundary = new Date(now);
    boundary.setUTCHours(5, 0, 0, 0);
    if (boundary > now) boundary.setUTCDate(boundary.getUTCDate() - 1);
    return boundary;
  }

  // Hourly, but only ever acting on orders from before the last 05:00.
  @Cron("0 * * * *")
  async run() {
    const now = new Date();
    // Both must hold: the order belongs to a finished business day, AND nobody
    // has touched it for an hour. At the 05:00 run itself the hour is the
    // tighter of the two, so that run behaves exactly as it always has.
    const boundary = OrdersAutoCompleteCron.businessDayBoundary(now);
    const graceCutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const cutoff = new Date(Math.min(boundary.getTime(), graceCutoff.getTime()));

    // Table Tabs — an OPEN dine-in tab (the table is still OCCUPIED and points
    // at this order as its running bill) must survive the rollover. It's real,
    // unpaid revenue: force-completing it would silently close the bill
    // without payment and strand the table as occupied-with-no-order. The tab
    // ages off normally once it's settled (Pay & close → COMPLETED + table
    // freed), so only genuinely open tabs are held back.
    const openTabs = await this.prisma.table.findMany({
      where: { status: "OCCUPIED", currentOrderId: { not: null } },
      select: { currentOrderId: true },
    });
    const openTabOrderIds = openTabs
      .map((t) => t.currentOrderId)
      .filter((id): id is string => id !== null);

    const rows = await this.prisma.order.findMany({
      where: {
        status: {
          in: OrdersAutoCompleteCron.IN_FLIGHT_STATUSES as any,
        },
        updatedAt: { lt: cutoff },
        ...(openTabOrderIds.length > 0 && {
          id: { notIn: openTabOrderIds },
        }),
      },
      select: { id: true, tenantId: true, status: true },
    });

    if (openTabOrderIds.length > 0) {
      this.logger.log(
        `Auto-complete: holding back ${openTabOrderIds.length} open table tab(s) from the rollover.`,
      );
    }

    if (rows.length === 0) {
      this.logger.debug("Auto-complete: no in-flight orders to roll over.");
      // Still sweep: a stranded assignment can outlive the order that made it.
      await this.settleDispatch();
      return;
    }

    const ids = rows.map((r) => r.id);
    await this.prisma.$transaction([
      // IMPORTANT: complete the status WITHOUT bumping `updatedAt`. The live
      // board shows terminal orders where `updatedAt >= today's 5am reset`.
      // A normal Prisma update (or updateMany) fires the @updatedAt hook and
      // stamps updatedAt = now() ≈ 05:00, which is exactly the board's cutoff
      // — so every rolled-over order would stay on the board all day instead
      // of clearing. A raw UPDATE leaves updatedAt at yesterday's value, so
      // the business-day cutoff ages them off immediately (which is the whole
      // point of the rollover).
      this.prisma.$executeRaw`
        UPDATE "orders"
        SET "status" = 'COMPLETED'
        WHERE "id" = ANY(${ids})
      `,
      this.prisma.orderStatusHistory.createMany({
        data: rows.map((r) => ({
          orderId: r.id,
          tenantId: r.tenantId,
          fromStatus: r.status as any,
          toStatus: "COMPLETED" as any,
          actorType: "SYSTEM" as any,
          note: "5am business-day rollover — auto-completed",
        })),
      }),
    ]);

    this.logger.log(
      `Auto-completed ${rows.length} orders at the 5am rollover (statuses: ${Array.from(
        new Set(rows.map((r) => r.status)),
      ).join(", ")}).`,
    );

    // The board is clean; now make dispatch agree. Completing the order alone
    // left the driver's assignment live, so the job stayed on the driver's
    // screen overnight and the driver stayed ON_JOB and off the available list.
    await this.settleDispatch();

    // Pay out what these orders earned.
    //
    // Called directly rather than by emitting order.status_changed, for two
    // reasons. The UPDATE above is deliberately raw SQL with no event — that
    // is the whole trick that keeps updatedAt at yesterday so the board can
    // age these off — so nothing is listening. And emitting at 5am would also
    // wake every marketplace sync listener and push a status nobody asked for
    // to Deliveroo, Uber and Careem in the middle of the night.
    //
    // Sequential, not Promise.all: this is a nightly sweep with no deadline,
    // and a hundred concurrent writes would spike the pool for no benefit.
    let stamped = 0;
    let referred = 0;
    for (const id of ids) {
      try {
        if ((await this.loyalty.awardForOrder(id)).stamped) stamped++;
      } catch (err) {
        this.logger.warn(
          `Rollover stamp for order ${id} failed: ${(err as Error).message}`,
        );
      }
      try {
        if (await this.referrals.qualifyForOrder(id)) referred++;
      } catch (err) {
        this.logger.warn(
          `Rollover referral for order ${id} failed: ${(err as Error).message}`,
        );
      }
    }
    if (stamped || referred) {
      this.logger.log(
        `Rollover awarded ${stamped} loyalty stamp(s) and settled ${referred} referral(s).`,
      );
    }
  }

  /**
   * Close the dispatch layer for every order that is now finished.
   *
   * Called explicitly because the UPDATE above is deliberately raw SQL with no
   * event, so nothing downstream hears it. The sweep goes by order status
   * rather than by the ids this run just wrote, which also heals assignments
   * stranded by completions that happened before any of this existed.
   *
   * Never allowed to fail the run: the orders are already completed, and the
   * next night's sweep picks up anything this misses.
   */
  private async settleDispatch(): Promise<void> {
    try {
      const { assignments, driversFreed } =
        await this.dispatchSettlement.sweepTerminalOrders();
      if (assignments > 0) {
        this.logger.log(
          `Rollover settled ${assignments} driver assignment(s); ${driversFreed} driver(s) back on the available list.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Rollover dispatch settlement failed: ${(err as Error).message}`,
      );
    }
  }
}
