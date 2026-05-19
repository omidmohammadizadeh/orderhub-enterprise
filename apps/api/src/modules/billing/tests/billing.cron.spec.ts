import { Logger } from "@nestjs/common";
import { BillingCron } from "../billing.cron";

jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

function makePrisma(overrides: Partial<{
  subscriptions: any[];
  locations: any[];
}> = {}) {
  const subs = overrides.subscriptions ?? [];
  const locs = overrides.locations ?? [];

  const db = {
    tenantSubscription: {
      findMany: jest.fn().mockResolvedValue(subs),
      updateMany: jest.fn().mockResolvedValue({ count: subs.length }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    location: {
      findMany: jest.fn().mockResolvedValue(locs),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

  return db;
}

function makeBillingService(expireCount = 0) {
  return {
    expireGracePeriods: jest.fn().mockResolvedValue(expireCount),
  };
}

function makeUsageService() {
  return {
    aggregateMonthlyUsage: jest.fn().mockResolvedValue(undefined),
  };
}

describe("BillingCron", () => {
  describe("expireGracePeriods", () => {
    it("calls billing.expireGracePeriods() and logs when tenants are moved", async () => {
      const prisma = makePrisma();
      const billing = makeBillingService(3);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.expireGracePeriods();

      expect(billing.expireGracePeriods).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — returns early if already running", async () => {
      const prisma = makePrisma();
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      // Simulate a long-running first invocation
      let resolveFirst!: () => void;
      billing.expireGracePeriods.mockReturnValueOnce(
        new Promise<number>((res) => { resolveFirst = () => res(0); }),
      );

      const first = cron.expireGracePeriods();
      const second = cron.expireGracePeriods(); // should return immediately
      resolveFirst();
      await Promise.all([first, second]);

      expect(billing.expireGracePeriods).toHaveBeenCalledTimes(1);
    });

    it("does not throw if expireGracePeriods rejects — logs and continues", async () => {
      const prisma = makePrisma();
      const billing = makeBillingService(0);
      billing.expireGracePeriods.mockRejectedValueOnce(new Error("DB error"));
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await expect(cron.expireGracePeriods()).resolves.toBeUndefined();
    });
  });

  describe("expireFreePilots", () => {
    it("moves FREE_PILOT tenants past trialEndsAt to TRIALING — never ACTIVE", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const subs = [
        { id: "sub-1", tenantId: "t1", trialEndsAt: pastDate },
        { id: "sub-2", tenantId: "t2", trialEndsAt: pastDate },
      ];

      const prisma = makePrisma({ subscriptions: subs });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.expireFreePilots();

      expect(prisma.tenantSubscription.update).toHaveBeenCalledTimes(2);
      const firstCall = prisma.tenantSubscription.update.mock.calls[0][0];
      expect(firstCall.data.status).toBe("TRIALING");
      expect(firstCall.data.status).not.toBe("ACTIVE");
    });

    it("sets a 30-day TRIALING period from expiry date", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 5);

      const prisma = makePrisma({
        subscriptions: [{ id: "sub-1", tenantId: "t1", trialEndsAt: pastDate }],
      });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.expireFreePilots();

      const call = prisma.tenantSubscription.update.mock.calls[0][0];
      const trialEnd: Date = call.data.trialEndsAt;
      const daysAhead = Math.round(
        (trialEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      // Should be ~30 days (allow ±1 for clock jitter in tests)
      expect(daysAhead).toBeGreaterThanOrEqual(29);
      expect(daysAhead).toBeLessThanOrEqual(31);
    });

    it("does nothing when no FREE_PILOT tenants have passed trialEndsAt", async () => {
      const prisma = makePrisma({ subscriptions: [] });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.expireFreePilots();

      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
    });

    it("records a freePilotEndedAt audit log entry for each tenant", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 2);

      const prisma = makePrisma({
        subscriptions: [{ id: "sub-1", tenantId: "t1", trialEndsAt: pastDate }],
      });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.expireFreePilots();

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = prisma.auditLog.create.mock.calls[0][0];
      expect(auditCall.data.tenantId).toBe("t1");
      expect(auditCall.data.event).toBe("billing.pilot_expired");
      expect(auditCall.data.meta.previousStatus).toBe("FREE_PILOT");
      expect(auditCall.data.meta.newStatus).toBe("TRIALING");
    });

    it("does not trigger Stripe subscription creation — no auto-charge", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const prisma = makePrisma({
        subscriptions: [{ id: "sub-1", tenantId: "t1", trialEndsAt: pastDate }],
      });
      const billing = makeBillingService(0);
      const stripeService = { createSubscription: jest.fn() };
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.expireFreePilots();

      // No Stripe subscription should ever be created automatically
      expect(stripeService.createSubscription).not.toHaveBeenCalled();
    });
  });

  describe("aggregateUsage", () => {
    it("calls usage.aggregateMonthlyUsage for each active location", async () => {
      const locations = [
        { id: "loc-1", brand: { tenant: { id: "t1", subscription: { id: "s1" } } } },
        { id: "loc-2", brand: { tenant: { id: "t1", subscription: { id: "s1" } } } },
      ];

      const prisma = makePrisma({ locations });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.aggregateUsage();

      expect(usage.aggregateMonthlyUsage).toHaveBeenCalledTimes(2);
      expect(usage.aggregateMonthlyUsage).toHaveBeenCalledWith("t1", "loc-1");
      expect(usage.aggregateMonthlyUsage).toHaveBeenCalledWith("t1", "loc-2");
    });

    it("skips dry run — does not call aggregateMonthlyUsage when USAGE_CRON_DRY_RUN=true", async () => {
      const locations = [
        { id: "loc-1", brand: { tenant: { id: "t1", subscription: { id: "s1" } } } },
      ];

      const originalEnv = process.env.USAGE_CRON_DRY_RUN;
      process.env.USAGE_CRON_DRY_RUN = "true";

      const prisma = makePrisma({ locations });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await cron.aggregateUsage();

      expect(usage.aggregateMonthlyUsage).not.toHaveBeenCalled();
      process.env.USAGE_CRON_DRY_RUN = originalEnv;
    });

    it("continues processing remaining locations after a single failure", async () => {
      const locations = [
        { id: "loc-1", brand: { tenant: { id: "t1", subscription: { id: "s1" } } } },
        { id: "loc-2", brand: { tenant: { id: "t2", subscription: { id: "s2" } } } },
        { id: "loc-3", brand: { tenant: { id: "t3", subscription: { id: "s3" } } } },
      ];

      const prisma = makePrisma({ locations });
      const billing = makeBillingService(0);
      const usage = makeUsageService();
      usage.aggregateMonthlyUsage.mockRejectedValueOnce(new Error("DB timeout"));
      const cron = new BillingCron(prisma as any, billing as any, usage as any);

      await expect(cron.aggregateUsage()).resolves.toBeUndefined();
      expect(usage.aggregateMonthlyUsage).toHaveBeenCalledTimes(3);
    });

    it("is idempotent — returns early if already running", async () => {
      const locations = [
        { id: "loc-1", brand: { tenant: { id: "t1", subscription: { id: "s1" } } } },
      ];

      const prisma = makePrisma({ locations });
      const billing = makeBillingService(0);
      const usage = makeUsageService();

      let resolveFirst!: () => void;
      usage.aggregateMonthlyUsage.mockReturnValueOnce(
        new Promise<void>((res) => { resolveFirst = () => res(); }),
      );

      const cron = new BillingCron(prisma as any, billing as any, usage as any);
      const first = cron.aggregateUsage();
      const second = cron.aggregateUsage(); // should return immediately (usageRunning = true)
      resolveFirst();
      await Promise.all([first, second]);

      expect(usage.aggregateMonthlyUsage).toHaveBeenCalledTimes(1);
    });
  });
});
