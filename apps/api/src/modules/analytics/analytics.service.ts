import { Injectable } from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface AnalyticsFilters {
  locationId?: string;
  from: Date;
  to: Date;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSalesSummary(tenantId: string, filters: AnalyticsFilters) {
    const { locationId, from, to } = filters;
    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: from, lte: to },
      status: { notIn: ["CANCELLED", "REJECTED"] },
    };

    const [totals, byPlatform, byOrderSource, byFulfillment] = await Promise.all([
      // Overall totals
      this.prisma.order.aggregate({
        where,
        _count: { id: true },
        _sum: { total: true, subtotal: true, taxAmount: true, deliveryFee: true, discount: true },
        _avg: { total: true },
      }),

      // Breakdown by platform
      this.prisma.order.groupBy({
        by: ["platform"],
        where,
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: "desc" } },
      }),

      // Breakdown by order source (ONLINE vs POS vs UBER_EATS etc.)
      this.prisma.order.groupBy({
        by: ["orderSource"],
        where,
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: "desc" } },
      }),

      // Breakdown by fulfillment type
      this.prisma.order.groupBy({
        by: ["fulfillmentType"],
        where,
        _count: { id: true },
        _sum: { total: true },
      }),
    ]);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        orderCount: totals._count.id,
        revenue: Number(totals._sum.total ?? 0),
        subtotal: Number(totals._sum.subtotal ?? 0),
        taxAmount: Number(totals._sum.taxAmount ?? 0),
        deliveryFee: Number(totals._sum.deliveryFee ?? 0),
        discount: Number(totals._sum.discount ?? 0),
        averageOrderValue: Number(totals._avg.total ?? 0),
      },
      byPlatform: byPlatform.map((r) => ({
        platform: r.platform,
        orderCount: r._count.id,
        revenue: Number(r._sum.total ?? 0),
      })),
      byOrderSource: byOrderSource.map((r) => ({
        orderSource: r.orderSource,
        orderCount: r._count.id,
        revenue: Number(r._sum.total ?? 0),
      })),
      byFulfillmentType: byFulfillment.map((r) => ({
        fulfillmentType: r.fulfillmentType,
        orderCount: r._count.id,
        revenue: Number(r._sum.total ?? 0),
      })),
    };
  }

  async getCancellationMetrics(tenantId: string, filters: AnalyticsFilters) {
    const { locationId, from, to } = filters;
    const baseWhere: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: from, lte: to },
    };

    const [total, cancelled, byReason] = await Promise.all([
      this.prisma.order.count({ where: baseWhere }),
      this.prisma.order.count({ where: { ...baseWhere, status: "CANCELLED" } }),
      this.prisma.order.groupBy({
        by: ["cancelReason"],
        where: { ...baseWhere, status: "CANCELLED" },
        _count: { id: true },
      }),
    ]);

    return {
      totalOrders: total,
      cancelledOrders: cancelled,
      cancellationRate: total > 0 ? (cancelled / total) * 100 : 0,
      byReason: byReason.map((r) => ({
        reason: r.cancelReason ?? "No reason",
        count: r._count.id,
      })),
    };
  }

  async getAvgPrepTimes(tenantId: string, filters: AnalyticsFilters) {
    const { locationId, from, to } = filters;

    // Average time from PENDING → ACCEPTED and ACCEPTED → READY
    const completedOrders = await this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        createdAt: { gte: from, lte: to },
        status: { in: ["COMPLETED", "READY", "DISPATCHED"] },
        acceptedAt: { not: null },
      },
      select: {
        receivedAt: true,
        acceptedAt: true,
        preparingAt: true,
        readyAt: true,
        platform: true,
        orderSource: true,
      },
    });

    if (completedOrders.length === 0) {
      return { sampleSize: 0, avgAcceptanceSecs: null, avgPrepSecs: null, byPlatform: [] };
    }

    const acceptTimes = completedOrders
      .filter((o) => o.acceptedAt)
      .map((o) => (o.acceptedAt!.getTime() - o.receivedAt.getTime()) / 1000);

    const prepTimes = completedOrders
      .filter((o) => o.readyAt && o.acceptedAt)
      .map((o) => (o.readyAt!.getTime() - o.acceptedAt!.getTime()) / 1000);

    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    return {
      sampleSize: completedOrders.length,
      avgAcceptanceSecs: avg(acceptTimes),
      avgPrepSecs: avg(prepTimes),
    };
  }

  async getHubriseAudit(tenantId: string, filters: AnalyticsFilters) {
    const { locationId, from, to } = filters;
    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: from, lte: to },
    };

    const [direct, viaHubrise] = await Promise.all([
      this.prisma.order.count({ where: { ...where, viaHubrise: false } }),
      this.prisma.order.count({ where: { ...where, viaHubrise: true } }),
    ]);

    return {
      directOrders: direct,
      hubriseOrders: viaHubrise,
      total: direct + viaHubrise,
      hubrisePercent: direct + viaHubrise > 0 ? (viaHubrise / (direct + viaHubrise)) * 100 : 0,
    };
  }
}
