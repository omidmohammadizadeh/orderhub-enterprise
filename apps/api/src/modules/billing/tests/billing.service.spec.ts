import { BillingService } from "../billing.service";
import { NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    tenantSubscription: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    subscriptionPlan: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    invoice: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    tenant: { findUnique: jest.fn() },
    ...overrides,
  };
}

describe("BillingService", () => {
  let service: BillingService;
  let db: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    db = makePrisma();
    service = new BillingService(db as any);
  });

  // ── Plan queries ───────────────────────────────────────────────────────────

  describe("getPlans", () => {
    it("returns active plans ordered by price", async () => {
      db.subscriptionPlan.findMany.mockResolvedValue([
        { id: "p1", name: "STARTER" },
        { id: "p2", name: "PROFESSIONAL" },
      ]);
      const plans = await service.getPlans();
      expect(plans).toHaveLength(2);
      expect(db.subscriptionPlan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  describe("getPlanById", () => {
    it("throws NotFoundException when plan not found", async () => {
      db.subscriptionPlan.findUnique.mockResolvedValue(null);
      await expect(service.getPlanById("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  // ── Subscription lifecycle ─────────────────────────────────────────────────

  describe("createSubscription", () => {
    it("creates a subscription with ACTIVE status", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue(null);
      db.subscriptionPlan.findUnique.mockResolvedValue({ id: "plan-1", name: "STARTER" });
      db.tenantSubscription.create.mockResolvedValue({
        id: "sub-1",
        tenantId: "t1",
        planId: "plan-1",
        status: "ACTIVE",
      });

      const sub = await service.createSubscription("t1", { planId: "plan-1" });
      expect(sub.status).toBe("ACTIVE");
      expect(db.tenantSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: "t1", status: "ACTIVE" }),
        }),
      );
    });

    it("throws ConflictException if subscription already exists", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({ id: "existing" });
      await expect(
        service.createSubscription("t1", { planId: "plan-1" }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("updateSubscription", () => {
    it("rejects plan change on a cancelled subscription", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        id: "sub-1",
        tenantId: "t1",
        planId: "plan-1",
        status: "CANCELLED",
        plan: { name: "STARTER" },
      });
      db.subscriptionPlan.findUnique.mockResolvedValue({ id: "plan-2", name: "PROFESSIONAL" });
      await expect(
        service.updateSubscription("t1", { planId: "plan-2" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("is a no-op when the same plan is requested", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        id: "sub-1",
        planId: "plan-1",
        status: "ACTIVE",
        plan: { name: "STARTER" },
      });
      db.subscriptionPlan.findUnique.mockResolvedValue({ id: "plan-1", name: "STARTER" });
      const result = await service.updateSubscription("t1", { planId: "plan-1" });
      expect(db.tenantSubscription.update).not.toHaveBeenCalled();
      expect(result.planId).toBe("plan-1");
    });
  });

  describe("cancelSubscription", () => {
    it("marks cancelAtPeriodEnd=true, not immediate cancellation", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        id: "sub-1",
        tenantId: "t1",
        status: "ACTIVE",
        metadata: {},
      });
      db.tenantSubscription.update.mockResolvedValue({
        id: "sub-1",
        cancelAtPeriodEnd: true,
        status: "ACTIVE",
      });
      const result = await service.cancelSubscription("t1");
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.status).toBe("ACTIVE");
    });

    it("throws BadRequestException if already cancelled", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: "CANCELLED",
      });
      await expect(service.cancelSubscription("t1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── Grace period ───────────────────────────────────────────────────────────

  describe("applyGracePeriod", () => {
    it("sets status to PAST_DUE and gracePeriodEndsAt to 7 days from now", async () => {
      db.tenantSubscription.update.mockResolvedValue({});
      await service.applyGracePeriod("t1");

      const call = db.tenantSubscription.update.mock.calls[0][0];
      expect(call.data.status).toBe("PAST_DUE");
      expect(call.data.gracePeriodEndsAt).toBeInstanceOf(Date);

      const expectedExpiry = new Date();
      expectedExpiry.setDate(expectedExpiry.getDate() + 7);
      const diff = Math.abs(
        call.data.gracePeriodEndsAt.getTime() - expectedExpiry.getTime(),
      );
      expect(diff).toBeLessThan(5_000); // within 5 seconds of expected
    });
  });

  describe("expireGracePeriods", () => {
    it("moves PAST_DUE tenants with expired grace to UNPAID", async () => {
      db.tenantSubscription.updateMany.mockResolvedValue({ count: 2 });
      const count = await service.expireGracePeriods();
      expect(count).toBe(2);
      expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PAST_DUE" }),
          data: { status: "UNPAID" },
        }),
      );
    });

    it("returns 0 when no grace periods have expired", async () => {
      db.tenantSubscription.updateMany.mockResolvedValue({ count: 0 });
      const count = await service.expireGracePeriods();
      expect(count).toBe(0);
    });
  });

  // ── Feature access ─────────────────────────────────────────────────────────

  describe("checkFeatureAccess", () => {
    it("returns true for active subscription with matching feature", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        status: "ACTIVE",
        plan: { features: ["kds", "orders"], isActive: true },
      });
      const result = await service.checkFeatureAccess("t1", "kds");
      expect(result).toBe(true);
    });

    it("returns false for FREE_PILOT without the feature", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        status: "FREE_PILOT",
        plan: { features: ["orders"], isActive: true },
      });
      // FREE_PILOT has status not in ACTIVE/TRIALING → method returns false
      const result = await service.checkFeatureAccess("t1", "analytics");
      expect(result).toBe(false);
    });

    it("returns false for UNPAID subscription regardless of plan", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        status: "UNPAID",
        plan: { features: ["kds", "orders", "analytics"], isActive: true },
      });
      const result = await service.checkFeatureAccess("t1", "kds");
      expect(result).toBe(false);
    });

    it("returns false when no subscription exists", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue(null);
      const result = await service.checkFeatureAccess("t1", "kds");
      expect(result).toBe(false);
    });
  });

  // ── Pilot migration ────────────────────────────────────────────────────────

  describe("migrateToFreePilot", () => {
    it("updates existing subscription to FREE_PILOT", async () => {
      const trialEnd = new Date("2026-09-01");
      db.tenantSubscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: "ACTIVE",
        metadata: {},
      });
      db.tenantSubscription.update.mockResolvedValue({});

      await service.migrateToFreePilot("t1", trialEnd);

      expect(db.tenantSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: "t1" },
          data: expect.objectContaining({
            status: "FREE_PILOT",
            trialEndsAt: trialEnd,
          }),
        }),
      );
    });

    it("is a no-op (logs only) when no subscription exists", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue(null);
      await service.migrateToFreePilot("t1-new", new Date("2026-09-01"));
      expect(db.tenantSubscription.update).not.toHaveBeenCalled();
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  describe("getSubscription", () => {
    it("never exposes another tenant's subscription", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue(null);
      await expect(service.getSubscription("t1")).rejects.toThrow(NotFoundException);
    });

    it("resolves the correct tenantId from the query", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue({
        id: "sub-1",
        tenantId: "t1",
        status: "ACTIVE",
        plan: { name: "STARTER" },
        invoices: [],
      });
      const sub = await service.getSubscription("t1");
      expect(sub.tenantId).toBe("t1");
      expect(db.tenantSubscription.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: "t1" } }),
      );
    });
  });

  // ── Stripe webhook billing handler ─────────────────────────────────────────

  describe("handleStripeWebhookBilling (invoice.payment_failed)", () => {
    it("applies grace period on payment failure — status moves to PAST_DUE", async () => {
      db.tenantSubscription.findUnique.mockResolvedValue(null);
      db.tenantSubscription.updateMany.mockResolvedValue({ count: 1 });

      await service.handleStripeWebhookBilling({
        type: "invoice.payment_failed",
        data: { object: { subscription: "sub_stripe_123" } },
      });

      expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeSubId: "sub_stripe_123" },
          data: expect.objectContaining({ status: "PAST_DUE" }),
        }),
      );
    });
  });

  describe("handleStripeWebhookBilling (customer.subscription.deleted)", () => {
    it("marks subscription CANCELLED", async () => {
      db.tenantSubscription.updateMany.mockResolvedValue({ count: 1 });

      await service.handleStripeWebhookBilling({
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_stripe_123" } },
      });

      expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeSubId: "sub_stripe_123" },
          data: { status: "CANCELLED" },
        }),
      );
    });
  });

  // ── Idempotent webhook handling ────────────────────────────────────────────

  describe("handleStripeWebhookBilling (invoice.finalized — idempotency)", () => {
    it("does not create a duplicate invoice if stripeInvoiceId already exists", async () => {
      db.tenantSubscription.findFirst.mockResolvedValue({
        id: "sub-1",
        tenantId: "t1",
      });
      db.invoice.findUnique.mockResolvedValue({ id: "existing-invoice" });

      await service.handleStripeWebhookBilling({
        type: "invoice.finalized",
        data: {
          object: {
            id: "in_stripe_abc",
            subscription: "sub_stripe_123",
            number: "INV-2026-001",
            amount_due: 4900,
            currency: "gbp",
            due_date: null,
            invoice_pdf: null,
          },
        },
      });

      expect(db.invoice.create).not.toHaveBeenCalled();
    });
  });
});
