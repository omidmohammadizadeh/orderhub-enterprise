import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

function billingMonthStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  private readonly db: any;

  constructor(private readonly prisma: PrismaService) {
    this.db = prisma as any;
  }

  // Called by the nightly cron — never in the order hot path.
  // Upserts a UsageRecord for the current billing month.
  async aggregateMonthlyUsage(
    tenantId: string,
    locationId: string,
    month?: Date,
  ): Promise<void> {
    const billingMonth = billingMonthStart(month);
    const monthEnd = new Date(billingMonth);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    const subscription = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { id: true },
    });
    if (!subscription) {
      this.logger.warn(
        `UsageService: no subscription for tenant ${tenantId} — skipping usage aggregation`,
      );
      return;
    }

    const [orderCount, printJobCount, activeProviders] = await Promise.all([
      this.prisma.order.count({
        where: {
          tenantId,
          locationId,
          createdAt: { gte: billingMonth, lt: monthEnd },
          isSandbox: false,
        },
      }),
      this.prisma.printJob.count({
        where: {
          tenantId,
          locationId,
          createdAt: { gte: billingMonth, lt: monthEnd },
        },
      }),
      this.db.integration.count({
        where: {
          tenantId,
          locationId,
          status: "ACTIVE",
        },
      }),
    ]);

    await this.db.usageRecord.upsert({
      where: {
        tenantId_locationId_billingMonth: {
          tenantId,
          locationId,
          billingMonth,
        },
      },
      create: {
        tenantId,
        subscriptionId: subscription.id,
        locationId,
        billingMonth,
        orderCount,
        printJobCount,
        activeProviders,
        reportedToStripe: false,
      },
      update: {
        orderCount,
        printJobCount,
        activeProviders,
      },
    });

    this.logger.log(
      `UsageService: aggregated ${orderCount} orders, ${printJobCount} prints for ${tenantId}/${locationId} ${billingMonth.toISOString().slice(0, 7)}`,
    );
  }

  async getUsageSummary(
    tenantId: string,
    month?: Date,
  ): Promise<{
    billingMonth: string;
    locations: Array<{
      locationId: string;
      orderCount: number;
      printJobCount: number;
      activeProviders: number;
      reportedToStripe: boolean;
    }>;
    totalOrders: number;
  }> {
    const billingMonth = billingMonthStart(month);

    const records = await this.db.usageRecord.findMany({
      where: { tenantId, billingMonth },
      select: {
        locationId: true,
        orderCount: true,
        printJobCount: true,
        activeProviders: true,
        reportedToStripe: true,
      },
    });

    const totalOrders = records.reduce(
      (sum: number, r: any) => sum + r.orderCount,
      0,
    );

    return {
      billingMonth: billingMonth.toISOString().slice(0, 7),
      locations: records,
      totalOrders,
    };
  }

  async markReportedToStripe(
    tenantId: string,
    locationId: string,
    billingMonth: Date,
  ): Promise<void> {
    await this.db.usageRecord.update({
      where: {
        tenantId_locationId_billingMonth: {
          tenantId,
          locationId,
          billingMonth: billingMonthStart(billingMonth),
        },
      },
      data: { reportedToStripe: true, reportedAt: new Date() },
    });
  }
}
