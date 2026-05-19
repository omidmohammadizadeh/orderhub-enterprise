import { UsageService } from "../usage.service";

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    tenantSubscription: {
      findUnique: jest.fn(),
    },
    order: {
      count: jest.fn().mockResolvedValue(0),
    },
    printJob: {
      count: jest.fn().mockResolvedValue(0),
    },
    integration: {
      count: jest.fn().mockResolvedValue(0),
    },
    usageRecord: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    ...overrides,
  };
}

describe("UsageService", () => {
  let service: UsageService;
  let db: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    db = makePrisma();
    service = new UsageService(db as any);
  });

  describe("aggregateMonthlyUsage", () => {
    it("skips aggregation when tenant has no subscription", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue(null);
      await service.aggregateMonthlyUsage("t1", "loc-1");
      expect(db.usageRecord.upsert).not.toHaveBeenCalled();
    });

    it("upserts usage record with aggregated counts", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({ id: "sub-1" });
      db.order.count.mockResolvedValue(47);
      db.printJob.count.mockResolvedValue(52);
      db.integration.count.mockResolvedValue(2);
      db.usageRecord.upsert.mockResolvedValue({});

      await service.aggregateMonthlyUsage("t1", "loc-1");

      expect(db.usageRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            orderCount: 47,
            printJobCount: 52,
            activeProviders: 2,
            reportedToStripe: false,
          }),
          update: expect.objectContaining({
            orderCount: 47,
            printJobCount: 52,
            activeProviders: 2,
          }),
        }),
      );
    });

    it("scopes order count query to tenantId + locationId + not sandbox", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({ id: "sub-1" });
      db.usageRecord.upsert.mockResolvedValue({});

      await service.aggregateMonthlyUsage("t1", "loc-A");

      expect(db.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: "t1",
            locationId: "loc-A",
            isSandbox: false,
          }),
        }),
      );
    });

    it("uses billingMonth = first day of current UTC month", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({ id: "sub-1" });
      db.usageRecord.upsert.mockResolvedValue({});

      const specificDate = new Date("2026-06-15T12:00:00Z");
      await service.aggregateMonthlyUsage("t1", "loc-1", specificDate);

      const upsertCall = db.usageRecord.upsert.mock.calls[0][0];
      const billingMonth = upsertCall.create.billingMonth as Date;
      expect(billingMonth.getUTCFullYear()).toBe(2026);
      expect(billingMonth.getUTCMonth()).toBe(5); // June = 5
      expect(billingMonth.getUTCDate()).toBe(1);
    });
  });

  describe("getUsageSummary", () => {
    it("aggregates totalOrders across all locations", async () => {
      db.usageRecord.findMany.mockResolvedValue([
        { locationId: "loc-1", orderCount: 200, printJobCount: 210, activeProviders: 2, reportedToStripe: false },
        { locationId: "loc-2", orderCount: 150, printJobCount: 155, activeProviders: 1, reportedToStripe: true },
      ]);

      const summary = await service.getUsageSummary("t1");
      expect(summary.totalOrders).toBe(350);
      expect(summary.locations).toHaveLength(2);
    });

    it("returns billingMonth as YYYY-MM string", async () => {
      db.usageRecord.findMany.mockResolvedValue([]);
      const summary = await service.getUsageSummary("t1", new Date("2026-06-01"));
      expect(summary.billingMonth).toBe("2026-06");
    });
  });

  describe("markReportedToStripe", () => {
    it("sets reportedToStripe=true and reportedAt", async () => {
      db.usageRecord.update.mockResolvedValue({});
      await service.markReportedToStripe("t1", "loc-1", new Date("2026-06-15"));

      expect(db.usageRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reportedToStripe: true,
            reportedAt: expect.any(Date),
          }),
        }),
      );
    });
  });
});
