import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { BillingGuard, BILLING_EXEMPT_KEY } from "../../../common/guards/billing.guard";

function makeContext(user: any, isExempt = false): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

function makePrisma(sub: any) {
  return {
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
  };
}

describe("BillingGuard", () => {
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Reflector>;
  });

  it("allows access for @BillingExempt() routes without checking subscription", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const guard = new BillingGuard(reflector, {} as any);
    const result = await guard.canActivate(makeContext({ tenantId: "t1", role: "STAFF" }));
    expect(result).toBe(true);
  });

  it("allows PLATFORM_ADMIN regardless of subscription status", async () => {
    const prisma = makePrisma({ status: "UNPAID" });
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "PLATFORM_ADMIN" }),
    );
    expect(result).toBe(true);
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("allows ACTIVE subscription", async () => {
    const prisma = makePrisma({ status: "ACTIVE", gracePeriodEndsAt: null });
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
  });

  it("allows TRIALING subscription", async () => {
    const prisma = makePrisma({ status: "TRIALING", gracePeriodEndsAt: null });
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
  });

  it("allows FREE_PILOT subscription", async () => {
    const prisma = makePrisma({ status: "FREE_PILOT", gracePeriodEndsAt: null });
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
  });

  it("allows PAST_DUE within grace period", async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const prisma = makePrisma({ status: "PAST_DUE", gracePeriodEndsAt: futureDate });
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
  });

  it("throws ForbiddenException for PAST_DUE after grace period", async () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);
    const prisma = makePrisma({ status: "PAST_DUE", gracePeriodEndsAt: pastDate });
    const guard = new BillingGuard(reflector, prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "TENANT_OWNER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws ForbiddenException for UNPAID subscription", async () => {
    const prisma = makePrisma({ status: "UNPAID", gracePeriodEndsAt: null });
    const guard = new BillingGuard(reflector, prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "TENANT_OWNER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws ForbiddenException for CANCELLED subscription", async () => {
    const prisma = makePrisma({ status: "CANCELLED", gracePeriodEndsAt: null });
    const guard = new BillingGuard(reflector, prisma as any);
    await expect(
      guard.canActivate(makeContext({ tenantId: "t1", role: "TENANT_OWNER" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows request when no subscription record exists (tenant not yet billed)", async () => {
    const prisma = makePrisma(null);
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(
      makeContext({ tenantId: "t1", role: "TENANT_OWNER" }),
    );
    expect(result).toBe(true);
  });

  it("allows request when no user is attached (JWT guard handles auth)", async () => {
    const prisma = makePrisma(null);
    const guard = new BillingGuard(reflector, prisma as any);
    const result = await guard.canActivate(makeContext(undefined));
    expect(result).toBe(true);
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("always queries by tenantId from JWT — never from query params", async () => {
    const prisma = makePrisma({ status: "ACTIVE", gracePeriodEndsAt: null });
    const guard = new BillingGuard(reflector, prisma as any);
    await guard.canActivate(
      makeContext({ tenantId: "jwt-tenant-id", role: "MANAGER" }),
    );
    expect(prisma.tenantSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "jwt-tenant-id" } }),
    );
  });
});
