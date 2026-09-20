import { AnalyticsService } from "../analytics.service";

// Order.paymentMethod is free text written by the till DTO, the marketplace
// adapters, voice, group orders and the payment-link flow. The overview has
// to bucket that vocabulary into cash vs card without losing money down a
// gap when a new writer appears, and it has to do it per location.

type OrderSeed = {
  locationId?: string;
  total: number;
  paymentMethod: string | null;
  paymentStatus?: string;
  status?: string;
};

function order(seed: OrderSeed) {
  return {
    id: Math.random().toString(36).slice(2),
    status: seed.status ?? "COMPLETED",
    locationId: seed.locationId ?? "loc-1",
    brandId: "b1",
    orderSource: "DIRECT",
    subtotal: seed.total,
    discount: 0,
    deliveryFee: 0,
    taxAmount: 0,
    total: seed.total,
    paymentMethod: seed.paymentMethod,
    paymentStatus: seed.paymentStatus ?? "PAID",
    createdAt: new Date("2026-09-19T12:00:00Z"),
    postcode: null,
    items: [],
  };
}

function overviewFor(seeds: OrderSeed[], opts: { locationId?: string } = {}) {
  const rows = seeds.map(order);
  const prisma: any = {
    order: {
      findMany: jest
        .fn()
        // current window, then the comparison window
        .mockResolvedValueOnce(rows)
        .mockResolvedValue([]),
    },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    location: {
      findMany: jest.fn().mockResolvedValue([
        { id: "loc-1", name: "Best Kebab" },
        { id: "loc-2", name: "Grill House" },
      ]),
    },
    userLocation: { findMany: jest.fn().mockResolvedValue([]) },
    userBrand: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new AnalyticsService(prisma).getOverview("t1", {
    from: new Date("2026-09-19T00:00:00Z"),
    to: new Date("2026-09-20T00:00:00Z"),
    role: "TENANT_OWNER",
    ...opts,
  });
}

describe("Analytics overview — cash vs card", () => {
  it("splits cash from every flavour of card", async () => {
    const res = await overviewFor([
      { total: 10, paymentMethod: "CASH" },
      { total: 5, paymentMethod: "CASH" },
      { total: 20, paymentMethod: "CARD_TERMINAL" },
      { total: 30, paymentMethod: "ONLINE_CARD" },
      { total: 40, paymentMethod: "PAYMENT_LINK" },
      { total: 7, paymentMethod: "CARD" },
    ]);

    expect(res.paymentMix.cash).toEqual({ orders: 2, revenue: 15 });
    expect(res.paymentMix.card).toEqual({ orders: 4, revenue: 97 });
  });

  it("keeps a not-yet-paid collection order out of both buckets", async () => {
    const res = await overviewFor([
      { total: 12, paymentMethod: "PAY_ON_COLLECTION", paymentStatus: "PENDING" },
      { total: 8, paymentMethod: "CASH" },
    ]);

    expect(res.paymentMix.cash.revenue).toBe(8);
    expect(res.paymentMix.card.revenue).toBe(0);
    expect(res.paymentMix.pending).toEqual({ orders: 1, revenue: 12 });
  });

  it("surfaces an unrecognised method by name instead of dropping it", async () => {
    const res = await overviewFor([
      { total: 25, paymentMethod: "CRYPTO_WALLET" },
      { total: 15, paymentMethod: null },
    ]);

    expect(res.paymentMix.other).toEqual({ orders: 2, revenue: 40 });
    const methods = res.paymentMix.byMethod.map((m) => m.method);
    expect(methods).toContain("CRYPTO_WALLET");
    expect(methods).toContain("UNSPECIFIED");
  });

  it("reads settled money off the payment status, not the method", async () => {
    const res = await overviewFor([
      { total: 30, paymentMethod: "CARD_TERMINAL", paymentStatus: "PENDING" },
      { total: 20, paymentMethod: "CARD_TERMINAL", paymentStatus: "PAID" },
    ]);

    // Both are card takings...
    expect(res.paymentMix.card.revenue).toBe(50);
    // ...but only one of them is money in the account.
    expect(res.paymentMix.paidRevenue).toBe(20);
    expect(res.paymentMix.unpaidRevenue).toBe(30);
    expect(res.paymentMix.unpaidOrders).toBe(1);
  });

  it("gives every location its own cash and card totals", async () => {
    const res = await overviewFor([
      { locationId: "loc-1", total: 10, paymentMethod: "CASH" },
      { locationId: "loc-1", total: 40, paymentMethod: "CARD_TERMINAL" },
      { locationId: "loc-2", total: 25, paymentMethod: "CASH" },
    ]);

    const byId = new Map(res.byLocation.map((l) => [l.id, l]));
    expect(byId.get("loc-1")).toMatchObject({
      name: "Best Kebab",
      cashRevenue: 10,
      cardRevenue: 40,
    });
    expect(byId.get("loc-2")).toMatchObject({
      name: "Grill House",
      cashRevenue: 25,
      cardRevenue: 0,
    });
  });

  it("scopes the split to one location when the page filters to it", async () => {
    await overviewFor(
      [{ locationId: "loc-2", total: 25, paymentMethod: "CASH" }],
      { locationId: "loc-2" },
    ).then((res) => {
      expect(res.paymentMix.cash.revenue).toBe(25);
    });
  });

  it("leaves cancelled orders out of the takings", async () => {
    const res = await overviewFor([
      { total: 10, paymentMethod: "CASH" },
      { total: 99, paymentMethod: "CASH", status: "CANCELLED" },
      { total: 50, paymentMethod: "CARD", status: "FAILED" },
    ]);

    expect(res.paymentMix.cash.revenue).toBe(10);
    expect(res.paymentMix.card.revenue).toBe(0);
  });
});
