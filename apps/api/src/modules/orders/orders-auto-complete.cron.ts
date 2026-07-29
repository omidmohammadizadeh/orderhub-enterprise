import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AW-27 — Daily auto-complete at the business-day rollover.
//
// At 05:00 UTC every day (≈ 05:00 GMT / 06:00 BST, matching the
// operator's "next shift" cutoff) we flip every non-terminal order
// to COMPLETED so the next morning starts with a clean board.
//
// In-scope statuses (anything that can still legitimately progress):
//   PENDING, ACCEPTED, PREPARING, READY, DISPATCHED,
//   PENDING_DISPATCH, ASSIGNED_DRIVER, ACCEPTED_BY_DRIVER,
//   OUT_FOR_DELIVERY
//
// Out-of-scope (already terminal — left untouched):
//   COMPLETED, CANCELLED, REJECTED, FAILED, REFUNDED
//
// We also bound by `updatedAt < 24h ago` so a fresh order placed at
// 04:59 doesn't get completed five minutes later. The cron writes a
// status-history row tagged "SYSTEM / 5am-rollover" so the audit
// trail explains why the status flipped without operator input.

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

  constructor(private readonly prisma: PrismaService) {}

  // 05:00 UTC daily.
  @Cron("0 5 * * *")
  async run() {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1h grace

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
      this.logger.log("Auto-complete: no in-flight orders to roll over.");
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
  }
}
