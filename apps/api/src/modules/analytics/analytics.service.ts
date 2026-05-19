import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface AnalyticsFilters {
  locationId?: string;
  from: Date;
  to: Date;
}

export interface SalesOverviewOpts {
  locationId?: string;
  startDate: Date;
  endDate: Date;
  granularity: "day" | "week" | "month";
}

export interface PlatformComparisonOpts {
  locationId?: string;
  startDate: Date;
  endDate: Date;
}

export interface TopItemsOpts {
  locationId?: string;
  startDate: Date;
  endDate: Date;
  limit?: number;
}

export interface ItemPerformanceOpts {
  locationId?: string;
  startDate: Date;
  endDate: Date;
}

export interface CustomerMetricsOpts {
  startDate: Date;
  endDate: Date;
}

export interface KitchenSlaOpts {
  startDate: Date;
  endDate: Date;
}

export interface CancellationOpts {
  locationId?: string;
  startDate: Date;
  endDate: Date;
}

export interface DriverMetricsOpts {
  startDate: Date;
  endDate: Date;
}

const SLA_THRESHOLD_MIN = 20;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── LEGACY METHODS (preserved for backward compat) ───────────────────────────

  async getSalesSummary(tenantId: string, filters: AnalyticsFilters) {
    const { locationId, from, to } = filters;
    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: from, lte: to },
      status: { notIn: ["CANCELLED", "REJECTED"] },
    };

    const [totals, byPlatform, byOrderSource, byFulfillment] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _count: { id: true },
        _sum: { total: true, subtotal: true, taxAmount: true, deliveryFee: true, discount: true },
        _avg: { total: true },
      }),
      this.prisma.order.groupBy({
        by: ["platform"],
        where,
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: "desc" } },
      }),
      this.prisma.order.groupBy({
        by: ["orderSource"],
        where,
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: "desc" } },
      }),
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
      return { sampleSize: 0, avgAcceptanceSecs: null, avgPrepSecs: null };
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

  // ── REAL-TIME DASHBOARD ───────────────────────────────────────────────────────

  async getLiveDashboard(tenantId: string, locationId?: string, hoursBack = 24) {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const baseWhere: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: since },
    };

    const [aggregate, byPlatform, byStatus, activeOrders, recentOrders, prepOrders] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: { ...baseWhere, status: { notIn: ["CANCELLED", "REJECTED"] } },
          _count: { id: true },
          _sum: { total: true },
          _avg: { total: true },
        }),
        this.prisma.order.groupBy({
          by: ["platform"],
          where: { ...baseWhere, status: { notIn: ["CANCELLED", "REJECTED"] } },
          _count: { id: true },
          _sum: { total: true },
        }),
        this.prisma.order.groupBy({
          by: ["status"],
          where: baseWhere,
          _count: { id: true },
        }),
        this.prisma.order.count({
          where: {
            ...baseWhere,
            status: { in: ["PENDING", "ACCEPTED", "PREPARING"] },
          },
        }),
        this.prisma.order.findMany({
          where: baseWhere,
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            displayId: true,
            status: true,
            platform: true,
            total: true,
            fulfillmentType: true,
            createdAt: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        }),
        this.prisma.order.findMany({
          where: {
            ...baseWhere,
            acceptedAt: { not: null },
            readyAt: { not: null },
          },
          select: { acceptedAt: true, readyAt: true },
        }),
      ]);

    const prepTimesMin = prepOrders
      .filter((o) => o.acceptedAt && o.readyAt)
      .map((o) => (o.readyAt!.getTime() - o.acceptedAt!.getTime()) / 60000);

    const avgPrepTimeMin =
      prepTimesMin.length > 0
        ? prepTimesMin.reduce((s, v) => s + v, 0) / prepTimesMin.length
        : null;

    return {
      period: { since: since.toISOString(), hoursBack },
      ordersCount: aggregate._count.id,
      revenue: Number(aggregate._sum.total ?? 0),
      avgOrderValue: Number(aggregate._avg.total ?? 0),
      activeOrders,
      avgPrepTimeMin: avgPrepTimeMin !== null ? Math.round(avgPrepTimeMin * 10) / 10 : null,
      ordersByPlatform: byPlatform.map((r) => ({
        platform: r.platform,
        count: r._count.id,
        revenue: Number(r._sum.total ?? 0),
      })),
      ordersByStatus: byStatus.map((r) => ({
        status: r.status,
        count: r._count.id,
      })),
      recentOrders,
    };
  }

  // ── SALES ANALYTICS ───────────────────────────────────────────────────────────

  async getSalesOverview(tenantId: string, opts: SalesOverviewOpts) {
    const { locationId, startDate, endDate, granularity } = opts;

    // Try DailySalesSnapshot first
    const snapshots = await this.prisma.dailySalesSnapshot.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: "asc" },
    });

    if (snapshots.length > 0) {
      if (granularity === "day") {
        return snapshots.map((s) => ({
          date: s.date.toISOString().split("T")[0],
          revenue: Number(s.totalRevenue),
          orders: s.totalOrders,
          avgOrderValue: Number(s.avgOrderValue),
          newCustomers: s.newCustomers,
        }));
      }

      // Aggregate snapshots by week or month
      const buckets = new Map<
        string,
        { revenue: number; orders: number; newCustomers: number }
      >();

      for (const s of snapshots) {
        const key = this.bucketKey(s.date, granularity);
        const existing = buckets.get(key) ?? { revenue: 0, orders: 0, newCustomers: 0 };
        existing.revenue += Number(s.totalRevenue);
        existing.orders += s.totalOrders;
        existing.newCustomers += s.newCustomers;
        buckets.set(key, existing);
      }

      return Array.from(buckets.entries()).map(([date, v]) => ({
        date,
        revenue: v.revenue,
        orders: v.orders,
        avgOrderValue: v.orders > 0 ? v.revenue / v.orders : 0,
        newCustomers: v.newCustomers,
      }));
    }

    // Fallback: aggregate Order table
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        createdAt: { gte: startDate, lte: endDate },
        status: { notIn: ["CANCELLED", "REJECTED"] },
      },
      select: { createdAt: true, total: true, customerId: true },
      orderBy: { createdAt: "asc" },
    });

    const buckets = new Map<
      string,
      { revenue: number; orders: number; customerIds: Set<string> }
    >();

    for (const o of orders) {
      const key = this.bucketKey(o.createdAt, granularity);
      const existing = buckets.get(key) ?? {
        revenue: 0,
        orders: 0,
        customerIds: new Set<string>(),
      };
      existing.revenue += Number(o.total);
      existing.orders += 1;
      if (o.customerId) existing.customerIds.add(o.customerId);
      buckets.set(key, existing);
    }

    return Array.from(buckets.entries()).map(([date, v]) => ({
      date,
      revenue: v.revenue,
      orders: v.orders,
      avgOrderValue: v.orders > 0 ? v.revenue / v.orders : 0,
      newCustomers: v.customerIds.size,
    }));
  }

  async getPlatformComparison(tenantId: string, opts: PlatformComparisonOpts) {
    const { locationId, startDate, endDate } = opts;
    const baseWhere: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: startDate, lte: endDate },
    };

    const [byPlatformActive, byPlatformCancelled, totalByPlatform] = await Promise.all([
      this.prisma.order.groupBy({
        by: ["platform"],
        where: { ...baseWhere, status: { notIn: ["CANCELLED", "REJECTED"] } },
        _count: { id: true },
        _sum: { total: true },
        _avg: { total: true },
      }),
      this.prisma.order.groupBy({
        by: ["platform"],
        where: { ...baseWhere, status: "CANCELLED" },
        _count: { id: true },
      }),
      this.prisma.order.groupBy({
        by: ["platform"],
        where: baseWhere,
        _count: { id: true },
      }),
    ]);

    const cancelledMap = new Map(byPlatformCancelled.map((r) => [r.platform, r._count.id]));
    const totalMap = new Map(totalByPlatform.map((r) => [r.platform, r._count.id]));

    return byPlatformActive.map((r) => {
      const cancelled = cancelledMap.get(r.platform) ?? 0;
      const total = totalMap.get(r.platform) ?? r._count.id;
      return {
        platform: r.platform,
        orders: r._count.id,
        revenue: Number(r._sum.total ?? 0),
        avgOrderValue: Number(r._avg.total ?? 0),
        cancellationRate: total > 0 ? (cancelled / total) * 100 : 0,
      };
    });
  }

  async getLocationComparison(tenantId: string, startDate: Date, endDate: Date) {
    const [byLocation, locations] = await Promise.all([
      this.prisma.order.groupBy({
        by: ["locationId"],
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ["CANCELLED", "REJECTED"] },
        },
        _count: { id: true },
        _sum: { total: true },
        _avg: { total: true },
      }),
      this.prisma.location.findMany({
        where: { brand: { tenantId } } as any,
        select: { id: true, name: true },
      }),
    ]);

    const locationMap = new Map(locations.map((l) => [l.id, l.name]));

    return byLocation.map((r) => ({
      locationId: r.locationId,
      locationName: locationMap.get(r.locationId) ?? r.locationId,
      orders: r._count.id,
      revenue: Number(r._sum.total ?? 0),
      avgOrderValue: Number(r._avg.total ?? 0),
    }));
  }

  // ── PRODUCT ANALYTICS ─────────────────────────────────────────────────────────

  async getTopItems(tenantId: string, opts: TopItemsOpts) {
    const { locationId, startDate, endDate, limit = 20 } = opts;

    const items = await this.prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        order: {
          tenantId,
          ...(locationId && { locationId }),
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ["CANCELLED", "REJECTED"] },
        },
        menuItemId: { not: null },
      },
      _sum: { quantity: true },
      _count: { id: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: limit,
    });

    if (items.length === 0) return [];

    const menuItemIds = items.map((i) => i.menuItemId).filter(Boolean) as string[];
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      select: { id: true, name: true },
    });
    const menuItemMap = new Map(menuItems.map((m) => [m.id, m.name]));

    // Get revenue per item
    const revenueData = await this.prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        menuItemId: { in: menuItemIds },
        order: {
          tenantId,
          ...(locationId && { locationId }),
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ["CANCELLED", "REJECTED"] },
        },
      },
      _sum: { totalPrice: true, quantity: true },
    });
    const revenueMap = new Map(
      revenueData.map((r) => [r.menuItemId, Number(r._sum.totalPrice ?? 0)]),
    );

    return items.map((r) => {
      const totalSold = r._sum.quantity ?? 0;
      const totalRevenue = revenueMap.get(r.menuItemId!) ?? 0;
      return {
        menuItemId: r.menuItemId!,
        name: menuItemMap.get(r.menuItemId!) ?? "Unknown",
        totalSold,
        totalRevenue,
        avgPrice: totalSold > 0 ? totalRevenue / totalSold : 0,
      };
    });
  }

  async getItemPerformance(tenantId: string, menuItemId: string, opts: ItemPerformanceOpts) {
    const { locationId, startDate, endDate } = opts;

    // Try ItemPerformanceSnapshot first
    const snapshots = await this.prisma.itemPerformanceSnapshot.findMany({
      where: {
        tenantId,
        menuItemId,
        ...(locationId && { locationId }),
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: "asc" },
    });

    if (snapshots.length > 0) {
      return snapshots.map((s) => ({
        date: s.date.toISOString().split("T")[0],
        totalSold: s.totalSold,
        totalRevenue: Number(s.totalRevenue),
        cancelledQty: s.cancelledQty,
      }));
    }

    // Fallback: aggregate from OrderItem
    const rows = await this.prisma.orderItem.findMany({
      where: {
        menuItemId,
        order: {
          tenantId,
          ...(locationId && { locationId }),
          createdAt: { gte: startDate, lte: endDate },
        },
      },
      select: {
        quantity: true,
        totalPrice: true,
        order: { select: { createdAt: true, status: true } },
      },
    });

    const dayMap = new Map<
      string,
      { totalSold: number; totalRevenue: number; cancelledQty: number }
    >();

    for (const row of rows) {
      const day = row.order.createdAt.toISOString().split("T")[0]!;
      const existing = dayMap.get(day) ?? { totalSold: 0, totalRevenue: 0, cancelledQty: 0 };
      const isCancelled = row.order.status === "CANCELLED" || row.order.status === "REJECTED";
      if (!isCancelled) {
        existing.totalSold += row.quantity;
        existing.totalRevenue += Number(row.totalPrice);
      } else {
        existing.cancelledQty += row.quantity;
      }
      dayMap.set(day, existing);
    }

    return Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));
  }

  // ── CUSTOMER ANALYTICS ────────────────────────────────────────────────────────

  async getCustomerMetrics(tenantId: string, opts: CustomerMetricsOpts) {
    const { startDate, endDate } = opts;

    const [total, newCustomers, ordersInPeriod, topCustomers] = await Promise.all([
      this.prisma.customer.count({ where: { tenantId, isActive: true } }),
      this.prisma.customer.count({
        where: { tenantId, createdAt: { gte: startDate, lte: endDate } },
      }),
      this.prisma.order.groupBy({
        by: ["customerId"],
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ["CANCELLED", "REJECTED"] },
          customerId: { not: null },
        },
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: "desc" } },
        take: 20,
      }),
      this.prisma.order.groupBy({
        by: ["customerId"],
        where: {
          tenantId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ["CANCELLED", "REJECTED"] },
          customerId: { not: null },
        },
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: "desc" } },
        take: 10,
      }),
    ]);

    const returningCustomers = ordersInPeriod.filter((r) => (r._count.id ?? 0) > 1).length;
    const totalRevenue = ordersInPeriod.reduce((s, r) => s + Number(r._sum.total ?? 0), 0);
    const avgLifetimeValue =
      ordersInPeriod.length > 0 ? totalRevenue / ordersInPeriod.length : 0;

    const customerIds = topCustomers
      .map((r) => r.customerId)
      .filter(Boolean) as string[];
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    return {
      totalCustomers: total,
      newCustomers,
      returningCustomers,
      avgLifetimeValue: Math.round(avgLifetimeValue * 100) / 100,
      topCustomers: topCustomers.map((r) => {
        const c = customerMap.get(r.customerId!);
        return {
          customerId: r.customerId!,
          name: c ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() : "Unknown",
          totalOrders: r._count.id,
          totalSpend: Number(r._sum.total ?? 0),
        };
      }),
    };
  }

  async getLoyaltyAnalytics(tenantId: string) {
    const accounts = await this.prisma.loyaltyAccount.findMany({
      where: { tenantId },
      select: { tier: true, points: true, totalSpend: true },
    });

    const tierMap = new Map<string, { count: number; totalSpend: number }>();
    let totalPoints = 0;

    for (const a of accounts) {
      const existing = tierMap.get(a.tier) ?? { count: 0, totalSpend: 0 };
      existing.count += 1;
      existing.totalSpend += Number(a.totalSpend ?? 0);
      tierMap.set(a.tier, existing);
      totalPoints += a.points;
    }

    const byTier = Array.from(tierMap.entries()).map(([tier, v]) => ({
      tier,
      count: v.count,
      avgSpend: v.count > 0 ? v.totalSpend / v.count : 0,
    }));

    return {
      byTier,
      totalPoints,
      avgPoints: accounts.length > 0 ? totalPoints / accounts.length : 0,
    };
  }

  // ── OPERATIONAL ANALYTICS ─────────────────────────────────────────────────────

  async getKitchenSla(tenantId: string, locationId?: string, opts?: KitchenSlaOpts) {
    const startDate = opts?.startDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = opts?.endDate ?? new Date();

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        createdAt: { gte: startDate, lte: endDate },
        acceptedAt: { not: null },
        readyAt: { not: null },
        status: { in: ["COMPLETED", "READY", "DISPATCHED"] },
      },
      select: { acceptedAt: true, readyAt: true },
    });

    if (orders.length === 0) {
      return {
        avgPrepMin: null,
        p50PrepMin: null,
        p90PrepMin: null,
        overSlaCount: 0,
        overSlaRate: 0,
        slaThresholdMin: SLA_THRESHOLD_MIN,
      };
    }

    const prepMins = orders
      .map((o) => (o.readyAt!.getTime() - o.acceptedAt!.getTime()) / 60000)
      .sort((a, b) => a - b);

    const avg = prepMins.reduce((s, v) => s + v, 0) / prepMins.length;
    const overSlaCount = prepMins.filter((m) => m > SLA_THRESHOLD_MIN).length;

    return {
      avgPrepMin: Math.round(avg * 10) / 10,
      p50PrepMin: Math.round(percentile(prepMins, 50) * 10) / 10,
      p90PrepMin: Math.round(percentile(prepMins, 90) * 10) / 10,
      overSlaCount,
      overSlaRate: (overSlaCount / prepMins.length) * 100,
      slaThresholdMin: SLA_THRESHOLD_MIN,
    };
  }

  async getCancellationAnalytics(tenantId: string, opts: CancellationOpts) {
    const { locationId, startDate, endDate } = opts;
    const baseWhere: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      createdAt: { gte: startDate, lte: endDate },
    };

    const [total, byReason, byPlatformAll, byPlatformCancelled] = await Promise.all([
      this.prisma.order.count({ where: baseWhere }),
      this.prisma.order.groupBy({
        by: ["cancelReason"],
        where: { ...baseWhere, status: "CANCELLED" },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
      this.prisma.order.groupBy({
        by: ["platform"],
        where: baseWhere,
        _count: { id: true },
      }),
      this.prisma.order.groupBy({
        by: ["platform"],
        where: { ...baseWhere, status: "CANCELLED" },
        _count: { id: true },
      }),
    ]);

    const cancelledByPlatformMap = new Map(
      byPlatformCancelled.map((r) => [r.platform, r._count.id]),
    );
    const totalByPlatformMap = new Map(byPlatformAll.map((r) => [r.platform, r._count.id]));
    const totalCancelled = byReason.reduce((s, r) => s + r._count.id, 0);

    return {
      totalCancelled,
      cancellationRate: total > 0 ? (totalCancelled / total) * 100 : 0,
      byReason: byReason.map((r) => ({
        reason: r.cancelReason ?? "No reason",
        count: r._count.id,
      })),
      byPlatform: byPlatformAll.map((r) => {
        const cancelled = cancelledByPlatformMap.get(r.platform) ?? 0;
        const platformTotal = totalByPlatformMap.get(r.platform) ?? 0;
        return {
          platform: r.platform,
          count: cancelled,
          rate: platformTotal > 0 ? (cancelled / platformTotal) * 100 : 0,
        };
      }),
    };
  }

  async getDriverMetrics(tenantId: string, opts: DriverMetricsOpts) {
    const { startDate, endDate } = opts;

    const assignments = await this.prisma.driverAssignment.findMany({
      where: {
        status: "DELIVERED",
        deliveredAt: { not: null },
        assignedAt: { gte: startDate, lte: endDate },
        driver: { tenantId },
      },
      select: {
        driverId: true,
        assignedAt: true,
        deliveredAt: true,
        driver: { select: { firstName: true, lastName: true } },
      },
    });

    if (assignments.length === 0) {
      return { avgDeliveryMin: null, totalDeliveries: 0, byDriver: [] };
    }

    const driverMap = new Map<
      string,
      { deliveries: number; totalMin: number; name: string }
    >();

    let totalMin = 0;
    for (const a of assignments) {
      const min = (a.deliveredAt!.getTime() - a.assignedAt.getTime()) / 60000;
      totalMin += min;
      const existing = driverMap.get(a.driverId) ?? {
        deliveries: 0,
        totalMin: 0,
        name: `${a.driver.firstName} ${a.driver.lastName}`.trim(),
      };
      existing.deliveries += 1;
      existing.totalMin += min;
      driverMap.set(a.driverId, existing);
    }

    return {
      avgDeliveryMin: Math.round((totalMin / assignments.length) * 10) / 10,
      totalDeliveries: assignments.length,
      byDriver: Array.from(driverMap.entries()).map(([driverId, v]) => ({
        driverId,
        name: v.name,
        deliveries: v.deliveries,
        avgMin: Math.round((v.totalMin / v.deliveries) * 10) / 10,
      })),
    };
  }

  // ── SNAPSHOT GENERATION ───────────────────────────────────────────────────────

  async generateDailySnapshot(tenantId: string, locationId: string, date: Date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const [totals, newCustomers, repeatCustomers, cancelledOrders, platforms, prepOrders] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: {
            tenantId,
            locationId,
            createdAt: { gte: dayStart, lte: dayEnd },
            status: { notIn: ["CANCELLED", "REJECTED"] },
          },
          _count: { id: true },
          _sum: { total: true },
          _avg: { total: true },
        }),
        // New customers: created today and placed order today
        this.prisma.order.count({
          where: {
            tenantId,
            locationId,
            createdAt: { gte: dayStart, lte: dayEnd },
            status: { notIn: ["CANCELLED", "REJECTED"] },
            customer: { createdAt: { gte: dayStart, lte: dayEnd } },
          },
        }),
        // Repeat: customer has prior orders before today
        this.prisma.order.count({
          where: {
            tenantId,
            locationId,
            createdAt: { gte: dayStart, lte: dayEnd },
            status: { notIn: ["CANCELLED", "REJECTED"] },
            customer: { createdAt: { lt: dayStart } },
          },
        }),
        this.prisma.order.count({
          where: {
            tenantId,
            locationId,
            createdAt: { gte: dayStart, lte: dayEnd },
            status: "CANCELLED",
          },
        }),
        this.prisma.order.groupBy({
          by: ["platform"],
          where: {
            tenantId,
            locationId,
            createdAt: { gte: dayStart, lte: dayEnd },
            status: { notIn: ["CANCELLED", "REJECTED"] },
          },
          _count: { id: true },
          _sum: { total: true },
        }),
        this.prisma.order.findMany({
          where: {
            tenantId,
            locationId,
            createdAt: { gte: dayStart, lte: dayEnd },
            acceptedAt: { not: null },
            readyAt: { not: null },
          },
          select: { acceptedAt: true, readyAt: true },
        }),
      ]);

    const prepMins = prepOrders.map(
      (o) => (o.readyAt!.getTime() - o.acceptedAt!.getTime()) / 60000,
    );
    const avgPrepTimeMin =
      prepMins.length > 0
        ? prepMins.reduce((s, v) => s + v, 0) / prepMins.length
        : null;

    const snapshotData = {
      totalRevenue: Number(totals._sum.total ?? 0),
      totalOrders: totals._count.id,
      avgOrderValue: Number(totals._avg.total ?? 0),
      newCustomers,
      repeatCustomers,
      cancelledOrders,
      avgPrepTimeMin: avgPrepTimeMin !== null ? Math.round(avgPrepTimeMin * 10) / 10 : 0,
    };

    // Prisma does not match null in compound unique keys, so we use findFirst + upsert by id
    const existing = await this.prisma.dailySalesSnapshot.findFirst({
      where: { tenantId, locationId, date: dayStart, platform: null },
      select: { id: true },
    });

    const snapshot = existing
      ? await this.prisma.dailySalesSnapshot.update({
          where: { id: existing.id },
          data: snapshotData,
        })
      : await this.prisma.dailySalesSnapshot.create({
          data: {
            tenantId,
            locationId,
            date: dayStart,
            platform: null,
            ...snapshotData,
          },
        });

    this.logger.log(
      `Generated daily snapshot for tenant=${tenantId} location=${locationId} date=${dayStart.toISOString().split("T")[0]}`,
    );

    return snapshot;
  }

  async generateItemSnapshot(tenantId: string, locationId: string, date: Date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const itemGroups = await this.prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        menuItemId: { not: null },
        order: {
          tenantId,
          locationId,
          createdAt: { gte: dayStart, lte: dayEnd },
        },
      },
      _sum: { quantity: true, totalPrice: true },
    });

    const cancelledGroups = await this.prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        menuItemId: { not: null },
        order: {
          tenantId,
          locationId,
          createdAt: { gte: dayStart, lte: dayEnd },
          status: "CANCELLED",
        },
      },
      _sum: { quantity: true },
    });
    const cancelledMap = new Map(
      cancelledGroups.map((r) => [r.menuItemId, r._sum.quantity ?? 0]),
    );

    const snapshots = await Promise.all(
      itemGroups
        .filter((r) => r.menuItemId !== null)
        .map((r) =>
          this.prisma.itemPerformanceSnapshot.upsert({
            where: {
              tenantId_menuItemId_locationId_date: {
                tenantId,
                menuItemId: r.menuItemId!,
                locationId,
                date: dayStart,
              },
            },
            create: {
              tenantId,
              menuItemId: r.menuItemId!,
              locationId,
              date: dayStart,
              totalSold: r._sum.quantity ?? 0,
              totalRevenue: Number(r._sum.totalPrice ?? 0),
              cancelledQty: cancelledMap.get(r.menuItemId!) ?? 0,
            },
            update: {
              totalSold: r._sum.quantity ?? 0,
              totalRevenue: Number(r._sum.totalPrice ?? 0),
              cancelledQty: cancelledMap.get(r.menuItemId!) ?? 0,
            },
          }),
        ),
    );

    this.logger.log(
      `Generated item snapshots (${snapshots.length}) for tenant=${tenantId} location=${locationId} date=${dayStart.toISOString().split("T")[0]}`,
    );

    return { generated: snapshots.length };
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────────

  private bucketKey(date: Date, granularity: "day" | "week" | "month"): string {
    const d = new Date(date);
    if (granularity === "day") {
      return d.toISOString().split("T")[0]!;
    }
    if (granularity === "week") {
      // ISO week start: Monday
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d.setDate(diff));
      return monday.toISOString().split("T")[0]!;
    }
    // month
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}
