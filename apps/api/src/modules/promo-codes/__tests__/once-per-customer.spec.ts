import { PromoCodesService } from "../promo-codes.service";

// An email campaign's code is "one use per customer". Before this, a code had
// only a global maxUses, so one customer could reuse it on every order.

function make(promo: any, usesSoFar = 0) {
  const prisma: any = {
    promoCode: { findFirst: jest.fn().mockResolvedValue(promo), update: jest.fn().mockResolvedValue({}) },
    promoCodeRedemption: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ n: usesSoFar }]),
  };
  return { svc: new PromoCodesService(prisma), prisma };
}

const promo = {
  id: "p1", code: "WEEKEND20", type: "PERCENTAGE", value: 20, isActive: true,
  startAt: null, expiresAt: null, maxUses: null, usedCount: 0, minOrderValue: null,
  locationIds: [], maxUsesPerCustomer: 1,
};
const input = { code: "weekend20", locationId: "L1", subtotal: 30 };

describe("once-per-customer promo codes", () => {
  it("works the first time", async () => {
    const { svc } = make(promo, 0);
    const r = await svc.validate("t1", { ...input, customerAccountId: "acc1", requireCustomerForLimit: true });
    expect(r.valid).toBe(true);
    expect(r.discountAmount).toBe(6);
  });

  it("refuses the same customer a second time", async () => {
    const { svc, prisma } = make(promo, 1);
    const r = await svc.validate("t1", { ...input, customerAccountId: "acc1", requireCustomerForLimit: true });
    expect(r).toEqual({ valid: false, reason: "You've already used this code" });
    // Only real orders count: cancelled ones and abandoned unpaid ones don't.
    const sql = prisma.$queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain("'CANCELLED','REJECTED','FAILED'");
    expect(sql).toContain("interval '1 hour'");
  });

  it("online, asks a guest to sign in rather than letting the limit be dodged", async () => {
    const { svc } = make(promo, 0);
    const r = await svc.validate("t1", { ...input, requireCustomerForLimit: true });
    expect(r).toEqual({ valid: false, reason: "Please sign in to use this code" });
  });

  it("at the till, staff can still apply it without a customer", async () => {
    const { svc } = make(promo, 0);
    expect((await svc.validate("t1", input)).valid).toBe(true);
  });

  it("records who used it, once per order", async () => {
    const { svc, prisma } = make(promo);
    await svc.recordUse({ tenantId: "t1", code: "weekend20", orderId: "o1", customerAccountId: "acc1", customerEmail: "Sam@X.com" });
    expect(prisma.promoCodeRedemption.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ promoCodeId: "p1", orderId: "o1", customerAccountId: "acc1", customerEmail: "sam@x.com" })],
      skipDuplicates: true,
    });
    expect(prisma.promoCode.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { usedCount: { increment: 1 } } });
  });

  it("a code without a per-customer limit behaves as before", async () => {
    const { svc, prisma } = make({ ...promo, maxUsesPerCustomer: null });
    expect((await svc.validate("t1", input)).valid).toBe(true);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
