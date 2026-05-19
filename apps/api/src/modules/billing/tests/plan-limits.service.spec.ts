import { ForbiddenException } from "@nestjs/common";
import { PlanLimitsService } from "../plan-limits.service";

function makeDb(sub: any, locationCount = 0, userCount = 0) {
  return {
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
    location: {
      count: jest.fn().mockResolvedValue(locationCount),
    },
    user: {
      count: jest.fn().mockResolvedValue(userCount),
    },
  };
}

function makeSub(status: string, overrides: Record<string, any> = {}) {
  return {
    status,
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    plan: {
      name: "STARTER",
      maxLocations: 3,
      maxUsers: 10,
      features: ["ANALYTICS", "KDS"],
    },
    ...overrides,
  };
}

describe("PlanLimitsService", () => {
  describe("assertLocationLimit", () => {
    it("allows when FREE_PILOT — bypasses plan limits entirely", async () => {
      const db = makeDb(makeSub("FREE_PILOT"), 999);
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).resolves.toBeUndefined();
      expect(db.location.count).not.toHaveBeenCalled();
    });

    it("allows when TRIALING — bypasses plan limits entirely", async () => {
      const db = makeDb(makeSub("TRIALING"), 999);
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).resolves.toBeUndefined();
      expect(db.location.count).not.toHaveBeenCalled();
    });

    it("allows when under limit on ACTIVE plan", async () => {
      const db = makeDb(makeSub("ACTIVE"), 2);
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).resolves.toBeUndefined();
    });

    it("throws ForbiddenException when at limit on ACTIVE plan", async () => {
      const db = makeDb(makeSub("ACTIVE"), 3); // at limit (maxLocations = 3)
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException when over limit on ACTIVE plan", async () => {
      const db = makeDb(makeSub("ACTIVE"), 5);
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).rejects.toThrow(ForbiddenException);
    });

    it("allows when maxLocations is null (unlimited plan)", async () => {
      const sub = makeSub("ACTIVE", { plan: { name: "ENTERPRISE", maxLocations: null, maxUsers: null, features: [] } });
      const db = makeDb(sub, 999);
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).resolves.toBeUndefined();
    });

    it("allows when no subscription exists — pre-billing", async () => {
      const db = makeDb(null, 5);
      const svc = new PlanLimitsService({ ...db } as any);
      (svc as any).db = db;
      await expect(svc.assertLocationLimit("t1")).resolves.toBeUndefined();
    });
  });

  describe("assertUserLimit", () => {
    it("throws ForbiddenException when user count is at limit", async () => {
      const db = makeDb(makeSub("ACTIVE"), 0, 10); // at maxUsers=10
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      await expect(svc.assertUserLimit("t1")).rejects.toThrow(ForbiddenException);
    });

    it("allows when FREE_PILOT regardless of user count", async () => {
      const db = makeDb(makeSub("FREE_PILOT"), 0, 999);
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      await expect(svc.assertUserLimit("t1")).resolves.toBeUndefined();
      expect(db.user.count).not.toHaveBeenCalled();
    });
  });

  describe("assertFeature", () => {
    it("allows if feature is in plan", async () => {
      const db = makeDb(makeSub("ACTIVE"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      await expect(svc.assertFeature("t1", "ANALYTICS")).resolves.toBeUndefined();
    });

    it("throws ForbiddenException if feature is not in plan", async () => {
      const db = makeDb(makeSub("ACTIVE"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      await expect(svc.assertFeature("t1", "ADVANCED_REPORTING")).rejects.toThrow(ForbiddenException);
    });

    it("allows any feature for FREE_PILOT — bypass", async () => {
      const db = makeDb(makeSub("FREE_PILOT"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      await expect(svc.assertFeature("t1", "ANY_FEATURE")).resolves.toBeUndefined();
    });

    it("allows any feature for TRIALING — bypass", async () => {
      const db = makeDb(makeSub("TRIALING"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      await expect(svc.assertFeature("t1", "ANY_FEATURE")).resolves.toBeUndefined();
    });
  });

  describe("hasFeature", () => {
    it("returns true when feature is in plan", async () => {
      const db = makeDb(makeSub("ACTIVE"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      expect(await svc.hasFeature("t1", "KDS")).toBe(true);
    });

    it("returns false when feature is not in plan", async () => {
      const db = makeDb(makeSub("ACTIVE"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      expect(await svc.hasFeature("t1", "MISSING_FEATURE")).toBe(false);
    });

    it("returns true for all features when FREE_PILOT", async () => {
      const db = makeDb(makeSub("FREE_PILOT"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      expect(await svc.hasFeature("t1", "ANYTHING")).toBe(true);
    });
  });

  describe("getBillingWarnings", () => {
    it("returns empty array when ACTIVE and no impending issues", async () => {
      const db = makeDb(makeSub("ACTIVE"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(0);
    });

    it("returns warning when FREE_PILOT ends within 14 days", async () => {
      const soon = new Date();
      soon.setDate(soon.getDate() + 7);
      const db = makeDb(makeSub("FREE_PILOT", { trialEndsAt: soon }));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/free pilot ends in/i);
    });

    it("returns no warning when FREE_PILOT ends more than 14 days away", async () => {
      const later = new Date();
      later.setDate(later.getDate() + 30);
      const db = makeDb(makeSub("FREE_PILOT", { trialEndsAt: later }));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(0);
    });

    it("returns warning when TRIALING ends within 7 days", async () => {
      const soon = new Date();
      soon.setDate(soon.getDate() + 3);
      const db = makeDb(makeSub("TRIALING", { trialEndsAt: soon }));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/trial ends in/i);
    });

    it("returns warning with grace period deadline when PAST_DUE", async () => {
      const gracePeriodEnd = new Date();
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 4);
      const db = makeDb(makeSub("PAST_DUE", { gracePeriodEndsAt: gracePeriodEnd }));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/payment overdue/i);
    });

    it("returns restriction warning for UNPAID", async () => {
      const db = makeDb(makeSub("UNPAID"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/unpaid/i);
    });

    it("returns cancellation warning for CANCELLED", async () => {
      const db = makeDb(makeSub("CANCELLED"));
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/cancelled/i);
    });

    it("returns empty array when no subscription", async () => {
      const db = makeDb(null);
      const svc = new PlanLimitsService(db as any);
      (svc as any).db = db;
      const warnings = await svc.getBillingWarnings("t1");
      expect(warnings).toHaveLength(0);
    });
  });
});
