import { PromoCodesService } from "../promo-codes.service";

// Phase AM — PromoCode validate() unit tests.
//
// The service is pure-ish — it touches prisma.promoCode.findFirst once per
// validate. We stub that and exercise each guard branch.

function buildService(promo: any) {
  const prisma = {
    promoCode: {
      findFirst: jest.fn().mockResolvedValue(promo),
    },
  } as any;
  return new PromoCodesService(prisma);
}

const BASE_PROMO = {
  id: "p1",
  tenantId: "t1",
  code: "SAVE10",
  type: "PERCENTAGE",
  value: 10,
  description: null,
  minOrderValue: null,
  maxUses: null,
  usedCount: 0,
  startAt: null,
  expiresAt: null,
  isActive: true,
  locationIds: [],
};

describe("PromoCodesService.validate", () => {
  it("rejects unknown code", async () => {
    const svc = buildService(null);
    const r = await svc.validate("t1", { code: "NOPE", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it("rejects inactive", async () => {
    const svc = buildService({ ...BASE_PROMO, isActive: false });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/inactive/i);
  });

  it("rejects when usage limit reached", async () => {
    const svc = buildService({ ...BASE_PROMO, maxUses: 5, usedCount: 5 });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/usage limit/i);
  });

  it("rejects when minimum spend not met", async () => {
    const svc = buildService({ ...BASE_PROMO, minOrderValue: 20 });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/minimum spend/i);
  });

  it("rejects when expired", async () => {
    const svc = buildService({
      ...BASE_PROMO,
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it("rejects when location not in scope", async () => {
    const svc = buildService({ ...BASE_PROMO, locationIds: ["other"] });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/location/i);
  });

  it("computes 10% discount for PERCENTAGE", async () => {
    const svc = buildService({ ...BASE_PROMO, type: "PERCENTAGE", value: 10 });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 25 });
    expect(r.valid).toBe(true);
    expect(r.discountAmount).toBeCloseTo(2.5);
  });

  it("computes fixed discount capped at subtotal", async () => {
    const svc = buildService({ ...BASE_PROMO, type: "FIXED_AMOUNT", value: 50 });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 12 });
    expect(r.valid).toBe(true);
    expect(r.discountAmount).toBe(12);
  });

  it("returns freeDelivery=true for FREE_DELIVERY", async () => {
    const svc = buildService({ ...BASE_PROMO, type: "FREE_DELIVERY", value: 0 });
    const r = await svc.validate("t1", { code: "SAVE10", locationId: "loc1", subtotal: 10 });
    expect(r.valid).toBe(true);
    expect(r.freeDelivery).toBe(true);
  });

  it("case-insensitive code matching", async () => {
    const svc = buildService({ ...BASE_PROMO, code: "SAVE10", type: "PERCENTAGE", value: 10 });
    const r = await svc.validate("t1", { code: " save10 ", locationId: "loc1", subtotal: 30 });
    expect(r.valid).toBe(true);
  });
});
