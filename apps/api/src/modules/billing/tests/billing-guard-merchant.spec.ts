import { ForbiddenException } from "@nestjs/common";
import { BillingGuard } from "../../../common/guards/billing.guard";

// The guard reads BOTH subscription systems now.
//
// It was written against TenantSubscription (modules/billing) and returned
// `true` whenever a tenant had no row there. MerchantSubscription
// (modules/subscriptions) superseded that system in June and is what actually
// charges merchants — so every tenant billed the modern way fell through the
// `if (!sub) return true` and kept full access no matter what their card did.
//
// This ships in OBSERVE mode: it works out what it would have done, logs it,
// and lets the request through. Switching enforcement on for something that
// has never enforced can lock a live restaurant out of its till mid-service,
// so it wants evidence first.

const DAY = 24 * 60 * 60 * 1000;

const buildGuard = (
  merchantSubs: Array<{ status: string; currentPeriodEnd?: Date | null }> | Error,
  tenantSub: any = null,
) => {
  const prisma = {
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(tenantSub) },
    merchantSubscription: {
      findMany:
        merchantSubs instanceof Error
          ? jest.fn().mockRejectedValue(merchantSubs)
          : jest.fn().mockResolvedValue(
              merchantSubs.map((s) => ({
                currentPeriodEnd: null,
                locationId: "loc1",
                ...s,
              })),
            ),
    },
  } as any;
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  return new BillingGuard(reflector, prisma);
};

const ctx = (role = "MANAGER") =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user: { tenantId: "t1", role },
        method: "GET",
        url: "/v1/orders",
      }),
    }),
  }) as any;

afterEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
});

describe("BillingGuard — merchant subscriptions", () => {
  it("allows a tenant with an active per-location subscription", async () => {
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([{ status: "active" }]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("allows a tenant that has never been billed", async () => {
    // Mid-onboarding, or a shop we've chosen not to charge. Not a defaulter.
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("blocks an unpaid tenant once the grace window has passed", async () => {
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([
      { status: "unpaid", currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    ]);
    await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });

  it("still allows an unpaid tenant inside the grace window", async () => {
    // Nobody loses their till the same morning a card expires.
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([
      { status: "unpaid", currentPeriodEnd: new Date(Date.now() - 2 * DAY) },
    ]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("allows past_due while Stripe is still retrying the card", async () => {
    // Stripe's smart retries run for about two weeks. Cutting a shop off
    // mid-dunning beats Stripe to a conclusion it hasn't reached.
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([
      { status: "past_due", currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    ]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("allows a two-shop tenant when only one shop is paid", async () => {
    // Billing is per location, access is per tenant. Cutting off the paid shop
    // because the other lapsed would be indefensible.
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([
      { status: "unpaid", currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
      { status: "active" },
    ]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("observes without blocking by default", async () => {
    // The default. Same tenant that `enforce` would block above.
    const guard = buildGuard([
      { status: "unpaid", currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    ]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("skips the merchant check entirely when switched off", async () => {
    process.env.BILLING_ENFORCEMENT = "off";
    const guard = buildGuard([
      { status: "unpaid", currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    ]);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(guard["prisma"].merchantSubscription.findMany).not.toHaveBeenCalled();
  });

  it("fails OPEN when the lookup throws", async () => {
    // This guard is global. Anything thrown here takes down every
    // authenticated request for every tenant, paying or not — a worse outcome
    // than a few minutes of unenforced billing.
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard(new Error("connection terminated"));
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("never touches billing for a platform admin", async () => {
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([
      { status: "unpaid", currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    ]);
    await expect(guard.canActivate(ctx("PLATFORM_ADMIN"))).resolves.toBe(true);
  });

  it("leaves the tenant-level system in charge when it has a row", async () => {
    // A tenant on the older system keeps its existing behaviour exactly.
    process.env.BILLING_ENFORCEMENT = "enforce";
    const guard = buildGuard([{ status: "unpaid" }], { status: "ACTIVE" });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(guard["prisma"].merchantSubscription.findMany).not.toHaveBeenCalled();
  });
});
