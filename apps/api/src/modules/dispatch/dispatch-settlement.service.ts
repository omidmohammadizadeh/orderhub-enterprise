import { Injectable, Logger } from "@nestjs/common";
import {
  DriverAssignmentStatus,
  DriverPresenceStatus,
  OrderStatus,
} from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Closing the dispatch layer when an order reaches a terminal status.
//
// An order's status and its DriverAssignment are two separate rows, and only
// the driver's own "delivered" slide used to write both. Every other way an
// order could finish — the operator marking it complete on the board, a
// marketplace webhook, the 5am rollover — wrote `orders` and left the
// assignment sitting at ASSIGNED/ACCEPTED/PICKED_UP for ever. What that looked
// like in practice:
//
//   • the driver app still showed the job as active (getMyDay filters on the
//     ASSIGNMENT status and never looks at the order), so the next morning the
//     job card took over the screen — locked, if the stop had been picked up;
//   • the operator console kept counting it under that driver's active jobs;
//   • the driver stayed ON_JOB, which is what takes them off the dispatch
//     map's available list, so a shop quietly lost a rider;
//   • and because jobAction had no guard, actioning that stale card pushed the
//     order back to OUT_FOR_DELIVERY — a finished order back on the live board,
//     with a fresh push to HubRise and the customer's tracker relit.
//
// So: whenever an order goes terminal, settle its assignment the same way, and
// free the driver if that was their last live stop.
//
// The assignment's terminal status mirrors the order's, because it decides pay
// (cash-up counts DELIVERED assignments): COMPLETED → DELIVERED, and
// CANCELLED/REJECTED/FAILED → CANCELLED, which is what the driver's own "skip"
// writes.

const LIVE_ASSIGNMENT_STATUSES: DriverAssignmentStatus[] = [
  DriverAssignmentStatus.ASSIGNED,
  DriverAssignmentStatus.ACCEPTED,
  DriverAssignmentStatus.PICKED_UP,
];

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
  OrderStatus.FAILED,
];

/** How an order's ending maps onto the driver's assignment. */
export function assignmentOutcomeFor(
  orderStatus: OrderStatus,
): DriverAssignmentStatus | null {
  if (orderStatus === OrderStatus.COMPLETED) return DriverAssignmentStatus.DELIVERED;
  if (
    orderStatus === OrderStatus.CANCELLED ||
    orderStatus === OrderStatus.REJECTED ||
    orderStatus === OrderStatus.FAILED
  ) {
    return DriverAssignmentStatus.CANCELLED;
  }
  return null; // not terminal — nothing to settle
}

export interface DispatchSettlementResult {
  /** Assignments moved out of a live status. */
  assignments: number;
  /** Drivers taken off ON_JOB and put back on the available list. */
  driversFreed: number;
}

const NOTHING: DispatchSettlementResult = { assignments: 0, driversFreed: 0 };

interface SettleRow {
  id: string;
  driverId: string;
  outcome: DriverAssignmentStatus;
  /** When the order finished — stamped as deliveredAt so the delivery lands in
   *  the right day's cash-up rather than the moment we noticed. */
  at: Date;
}

@Injectable()
export class DispatchSettlementService {
  private readonly logger = new Logger(DispatchSettlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Settle one order's dispatch layer. Call it after the order has been
   * written to a terminal status.
   *
   * No tenant filter: assignments hang off the order, and every caller has
   * already resolved that order within its own tenant. A no-op (one indexed
   * lookup) for collection orders, dine-in tabs, marketplace-courier orders and
   * anything else with no live assignment, so it is safe on every status
   * change rather than only the ones we think might have a driver.
   */
  async settleForOrder(
    orderId: string,
    orderStatus: OrderStatus,
    at: Date,
  ): Promise<DispatchSettlementResult> {
    const outcome = assignmentOutcomeFor(orderStatus);
    if (!outcome) return NOTHING;

    const live = await this.prisma.driverAssignment.findMany({
      where: { orderId, status: { in: LIVE_ASSIGNMENT_STATUSES } },
      select: { id: true, driverId: true },
    });
    if (live.length === 0) return NOTHING;

    return this.settle(
      live.map((a) => ({ id: a.id, driverId: a.driverId, outcome, at })),
    );
  }

  /**
   * Sweep every live assignment whose order has already finished.
   *
   * Two jobs. It settles what the 5am rollover just completed (that writes raw
   * SQL with no event, so there is nothing to hook), and it self-heals the
   * backlog — assignments stranded by every completion that happened before
   * this reconciliation existed, plus anything a future direct write misses.
   * Tenant-wide by design: the caller is the nightly cron, which is global.
   */
  async sweepTerminalOrders(): Promise<DispatchSettlementResult> {
    const stale = await this.prisma.driverAssignment.findMany({
      where: {
        status: { in: LIVE_ASSIGNMENT_STATUSES },
        order: { status: { in: TERMINAL_ORDER_STATUSES } },
      },
      select: {
        id: true,
        driverId: true,
        order: { select: { status: true, updatedAt: true } },
      },
    });
    if (stale.length === 0) return NOTHING;

    const rows: SettleRow[] = [];
    for (const a of stale) {
      const outcome = assignmentOutcomeFor(a.order.status);
      if (!outcome) continue; // can't happen given the where, but don't guess
      rows.push({
        id: a.id,
        driverId: a.driverId,
        outcome,
        // The order's own updatedAt is when it finished. The rollover
        // deliberately leaves that at yesterday's value, which is exactly the
        // timestamp we want on the delivery.
        at: a.order.updatedAt,
      });
    }
    return this.settle(rows);
  }

  /** Write the assignments, then free whoever that finished off. */
  private async settle(rows: SettleRow[]): Promise<DispatchSettlementResult> {
    if (rows.length === 0) return NOTHING;

    // One statement per row because deliveredAt differs per order. Updates
    // only — no unique constraints in play, so nothing here can poison the
    // transaction the way a create() would.
    await this.prisma.$transaction(
      rows.map((r) =>
        this.prisma.driverAssignment.update({
          where: { id: r.id },
          data: {
            status: r.outcome,
            ...(r.outcome === DriverAssignmentStatus.DELIVERED
              ? { deliveredAt: r.at }
              : {}),
          },
        }),
      ),
    );

    const driversFreed = await this.freeDrivers(
      [...new Set(rows.map((r) => r.driverId))],
      new Set(rows.map((r) => r.id)),
    );

    this.logger.log(
      `Settled ${rows.length} dispatch assignment(s) for finished orders; ` +
        `${driversFreed} driver(s) back on the available list.`,
    );
    return { assignments: rows.length, driversFreed };
  }

  /**
   * Put drivers back on the available list once their run is genuinely over.
   *
   * Three cases, and the distinctions matter:
   *   • still has live stops (multi-drop) — stays ON_JOB. If the presence
   *     pointer was aimed at a stop we just settled it is repointed at the next
   *     one, never blanked, or the app's locked state flickers mid-run.
   *   • no live stops and ON_JOB — back to ONLINE, which is what puts them
   *     back in front of dispatch.
   *   • no live stops and OFFLINE — the pointer is cleared but the status is
   *     left alone. They went home; do not put them back on shift.
   */
  private async freeDrivers(
    driverIds: string[],
    settledAssignmentIds: Set<string>,
  ): Promise<number> {
    const [remaining, presences] = await Promise.all([
      this.prisma.driverAssignment.findMany({
        where: {
          driverId: { in: driverIds },
          status: { in: LIVE_ASSIGNMENT_STATUSES },
        },
        select: { id: true, driverId: true },
        orderBy: [{ sequence: "asc" }, { assignedAt: "asc" }],
      }),
      this.prisma.driverPresence.findMany({
        where: { driverId: { in: driverIds } },
        select: { driverId: true, status: true, activeAssignmentId: true },
      }),
    ]);

    const nextStopByDriver = new Map<string, string>();
    for (const r of remaining) {
      if (!nextStopByDriver.has(r.driverId)) nextStopByDriver.set(r.driverId, r.id);
    }

    let freed = 0;
    for (const p of presences) {
      const nextStop = nextStopByDriver.get(p.driverId);
      const pointerIsStale =
        p.activeAssignmentId != null && settledAssignmentIds.has(p.activeAssignmentId);

      if (nextStop) {
        if (pointerIsStale) {
          await this.prisma.driverPresence.update({
            where: { driverId: p.driverId },
            data: { activeAssignmentId: nextStop },
          });
        }
        continue;
      }

      if (p.status === DriverPresenceStatus.ON_JOB) {
        await this.prisma.driverPresence.update({
          where: { driverId: p.driverId },
          data: {
            status: DriverPresenceStatus.ONLINE,
            activeAssignmentId: null,
          },
        });
        freed++;
      } else if (p.activeAssignmentId != null) {
        await this.prisma.driverPresence.update({
          where: { driverId: p.driverId },
          data: { activeAssignmentId: null },
        });
      }
    }
    return freed;
  }
}
