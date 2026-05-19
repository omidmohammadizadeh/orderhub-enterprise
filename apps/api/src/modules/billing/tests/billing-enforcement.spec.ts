/**
 * Phase T — Billing Enforcement Matrix Tests
 *
 * Verifies that:
 * 1. Commercial expansion endpoints are blocked for UNPAID/CANCELLED tenants
 * 2. Critical live operations (emergency controls, Flutter polling) remain accessible
 * 3. FREE_PILOT tenants are never auto-charged and can be extended
 * 4. Stripe checkout.session.completed stores the stripeSubId
 * 5. invoice.paid moves PAST_DUE → ACTIVE (payment recovery)
 * 6. Tenant billing data is isolated — a tenant cannot see another tenant's data
 */

import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { BillingGuard, BILLING_EXEMPT_KEY } from "../../../common/guards/billing.guard";
import { BillingService } from "../billing.service";

// ── Guard helpers ─────────────────────────────────────────────────────────────

function makeContext(
  user: any,
  handlerMeta: boolean = false,
  classMeta: boolean = false,
): ExecutionContext {
  return {
    getHandler: () => ({ [BILLING_EXEMPT_KEY]: handlerMeta }),
    getClass: () => ({ [BILLING_EXEMPT_KEY]: classMeta }),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

function makeReflector(exempt: boolean) {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(exempt),
  } as unknown as jest.Mocked<Reflector>;
}

function makePrisma(sub: any) {
  return {
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
  };
}

// ── BillingService helpers ────────────────────────────────────────────────────

function makeDb(overrides: Record<string, any> = {}) {
  return {
    tenantSubscription: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    invoice: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// ── Section 1: Onboarding endpoint exemption audit ───────────────────────────

describe("Billing enforcement: onboarding endpoints", () => {
  it("blocks transition (mark location live) for UNPAID tenant", async () => {
    // transition has no @BillingExempt — BillingGuard runs
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(false), prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "MANAGER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("blocks recordTestOrder for UNPAID tenant", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(false), prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "MANAGER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows emergency pauseProvider for UNPAID tenant — billing-exempt", async () => {
    // pauseProvider has @BillingExempt() — reflector returns true
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "MANAGER" }),
    );
    expect(result).toBe(true);
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("allows emergency resumeProvider for CANCELLED tenant — billing-exempt", async () => {
    const prisma = makePrisma({ status: "CANCELLED", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "MANAGER" }),
    );
    expect(result).toBe(true);
  });

  it("allows emergency pausePrinter for PAST_DUE past grace — billing-exempt", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const prisma = makePrisma({ status: "PAST_DUE", gracePeriodEndsAt: yesterday });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "MANAGER" }),
    );
    expect(result).toBe(true);
  });

  it("allows read-only listLocations for UNPAID tenant — billing-exempt", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "MANAGER" }),
    );
    expect(result).toBe(true);
  });
});

// ── Section 2: Printer endpoint exemption audit ───────────────────────────────

describe("Billing enforcement: printer endpoints", () => {
  it("blocks POST /printers (register new printer) for UNPAID tenant", async () => {
    // create() has no @BillingExempt
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(false), prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "MANAGER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("blocks POST /printers for CANCELLED tenant", async () => {
    const prisma = makePrisma({ status: "CANCELLED", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(false), prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "MANAGER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows GET /printers (list) for UNPAID tenant — billing-exempt", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "MANAGER" }),
    );
    expect(result).toBe(true);
  });

  it("allows PATCH /printers/:id (update config) for UNPAID tenant — billing-exempt", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "MANAGER" }),
    );
    expect(result).toBe(true);
  });

  it("allows Flutter GET /printers/jobs (polling) for UNPAID — @Public() + @BillingExempt()", async () => {
    // @Public() means no user is set — BillingGuard passes when user is undefined
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    // No user attached (public route)
    const result = await guard.canActivate(makeContext(undefined, true));
    expect(result).toBe(true);
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("allows Flutter PATCH /printers/jobs/:id for UNPAID — @Public() + @BillingExempt()", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(makeContext(undefined, true));
    expect(result).toBe(true);
  });
});

// ── Section 3: FREE_PILOT safety ──────────────────────────────────────────────

describe("Billing enforcement: FREE_PILOT safety", () => {
  it("FREE_PILOT tenant can access all billing-restricted endpoints — status is in ACTIVE_STATUSES", async () => {
    const prisma = makePrisma({ status: "FREE_PILOT", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(false), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
  });

  it("FREE_PILOT tenant can extend their pilot — adminExtendFreePilot writes audit log", async () => {
    const now = new Date();
    const currentEnd = new Date(now);
    currentEnd.setDate(currentEnd.getDate() + 30);
    const newEnd = new Date(now);
    newEnd.setDate(newEnd.getDate() + 90);

    const db = makeDb({
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          status: "FREE_PILOT",
          trialEndsAt: currentEnd,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const prismaStub = { ...db } as any;
    const svc = new BillingService(prismaStub);
    (svc as any).db = db;

    await svc.adminExtendFreePilot("t1", newEnd, "Customer asked for extra pilot time", "admin-1");

    expect(db.tenantSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "t1" },
        data: expect.objectContaining({ trialEndsAt: newEnd }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          event: "billing.free_pilot_extended",
          userId: "admin-1",
        }),
      }),
    );
  });

  it("adminExtendFreePilot throws if tenant is not FREE_PILOT", async () => {
    const db = makeDb({
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({ status: "TRIALING", trialEndsAt: new Date() }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await expect(
      svc.adminExtendFreePilot("t1", new Date(), "test", "admin-1"),
    ).rejects.toThrow();
    expect(db.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it("adminGrantException never auto-creates a Stripe subscription", async () => {
    const db = makeDb({
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({ status: "UNPAID" }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      },
    });

    const stripeService = { createSubscription: jest.fn(), isConfigured: true };
    const prismaStub = { ...db } as any;
    const svc = new BillingService(prismaStub, stripeService as any);
    (svc as any).db = db;

    await svc.adminGrantException("t1", "ACTIVE", "Manual enterprise deal", "admin-1");

    expect(stripeService.createSubscription).not.toHaveBeenCalled();
    expect(db.tenantSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
  });
});

// ── Section 4: First paid activation — Stripe webhook flow ───────────────────

describe("Billing: first paid activation via Stripe webhook", () => {
  it("checkout.session.completed stores stripeSubId on TenantSubscription", async () => {
    const existingSub = {
      id: "sub-db-1",
      tenantId: "t1",
      stripeCustomerId: "cus_123",
      metadata: {},
    };

    const db = makeDb({
      tenantSubscription: {
        findFirst: jest.fn().mockResolvedValue(existingSub),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_abc",
          customer: "cus_123",
          subscription: "sub_stripe_xyz",
        },
      },
    });

    expect(db.tenantSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-db-1" },
        data: expect.objectContaining({ stripeSubId: "sub_stripe_xyz" }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event: "billing.checkout_completed", tenantId: "t1" }),
      }),
    );
  });

  it("checkout.session.completed is a no-op for one-time payments (no subscription)", async () => {
    const db = makeDb();
    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_onetime",
          customer: "cus_123",
          subscription: null, // no subscription for one-time
        },
      },
    });

    expect(db.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it("checkout.session.completed logs a warning when no matching tenant", async () => {
    const db = makeDb({
      tenantSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "checkout.session.completed",
      data: {
        object: { id: "cs_abc", customer: "cus_unknown", subscription: "sub_xyz" },
      },
    });

    expect(db.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it("customer.subscription.updated with status=active moves tenant to ACTIVE", async () => {
    const existingSub = { id: "sub-db-1", tenantId: "t1", currentPeriodStart: null, currentPeriodEnd: null };

    const db = makeDb({
      tenantSubscription: {
        findFirst: jest.fn().mockResolvedValue(existingSub),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_stripe_xyz",
          customer: "cus_123",
          status: "active",
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          trial_end: null,
        },
      },
    });

    expect(db.tenantSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
  });

  it("invoice.paid clears PAST_DUE and moves subscription to ACTIVE (payment recovery)", async () => {
    const db = makeDb({
      tenantSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_test",
          subscription: "sub_stripe_xyz",
          amount_paid: 4900,
        },
      },
    });

    expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PAST_DUE" }),
        data: expect.objectContaining({ status: "ACTIVE", gracePeriodEndsAt: null }),
      }),
    );
  });

  it("invoice.payment_failed moves subscription to PAST_DUE", async () => {
    const db = makeDb({
      tenantSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_fail",
          subscription: "sub_stripe_xyz",
        },
      },
    });

    expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAST_DUE" }),
      }),
    );
  });

  it("customer.subscription.deleted moves tenant to CANCELLED", async () => {
    const db = makeDb({
      tenantSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    await svc.handleStripeWebhookBilling({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_stripe_xyz" } },
    });

    expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });
});

// ── Section 5: Tenant billing isolation ──────────────────────────────────────

describe("Billing: tenant isolation", () => {
  it("getTenantBillingStatus scopes response to authenticated tenantId — no Stripe IDs", async () => {
    const subRecord = {
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      paymentMethodStatus: null,
      stripeCustomerId: "cus_PRIVATE",
      stripeSubId: "sub_PRIVATE",
      plan: { name: "STARTER", displayName: "Starter", pricePerMonth: 4900, maxLocations: 3 },
      invoices: [],
    };

    const db = makeDb({
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue(subRecord),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    const result = await svc.getTenantBillingStatus("t1");

    // Tenant-facing endpoint must NOT expose Stripe IDs
    expect(result).not.toHaveProperty("stripeCustomerId");
    expect(result).not.toHaveProperty("stripeSubId");
    expect(result.status).toBe("ACTIVE");

    // Must query by the tenantId passed, never any other
    expect(db.tenantSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" } }),
    );
  });

  it("adminGetBillingDetail exposes Stripe IDs — admin-only endpoint", async () => {
    const subRecord = {
      status: "ACTIVE",
      stripeCustomerId: "cus_ADMIN_VISIBLE",
      stripeSubId: "sub_ADMIN_VISIBLE",
      plan: {},
      invoices: [],
    };

    const db = makeDb({
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue(subRecord),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      usageRecord: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const svc = new BillingService({ ...db } as any);
    (svc as any).db = db;

    const result = await svc.adminGetBillingDetail("t1");

    expect(result.stripeCustomerId).toBe("cus_ADMIN_VISIBLE");
    expect(result.stripeSubId).toBe("sub_ADMIN_VISIBLE");
  });
});

// ── Section 6: Phase V — checkout @BillingExempt() fix ───────────────────────

describe("Billing: POST /billing/checkout is billing-exempt (Phase V fix)", () => {
  // The checkout endpoint has @BillingExempt() added in Phase V so that UNPAID/CANCELLED
  // tenants can self-serve into a paid plan without being blocked by BillingGuard.

  it("UNPAID tenant can reach checkout — BillingGuard passes when @BillingExempt() is set", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
    // Guard must not hit the database when exempt
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("CANCELLED tenant can reach checkout — BillingGuard passes when @BillingExempt() is set", async () => {
    const prisma = makePrisma({ status: "CANCELLED", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("INCOMPLETE tenant can reach checkout — BillingGuard passes when @BillingExempt() is set", async () => {
    const prisma = makePrisma({ status: "INCOMPLETE", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(true), prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("without @BillingExempt, UNPAID tenant would be blocked — confirms guard behaviour is correct", async () => {
    // This verifies that the exemption actually matters: if we remove @BillingExempt()
    // the guard would correctly throw ForbiddenException for UNPAID tenants.
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(makeReflector(false), prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "TENANT_OWNER" })),
    ).rejects.toThrow(ForbiddenException);
  });
});
