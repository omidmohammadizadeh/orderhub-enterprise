import { AnalyticsService } from "../analytics.service";

// WHAT GROSS AND NET MEAN, PINNED TO A REAL ORDER.
//
// Just Eat order 965460811 at Mulgrave, 7 Oct 2026: £14.99 subtotal, £0.49
// delivery, £1.64 service charge, £17.12 charged. The overview reported
// £15.48 gross — it summed subtotal + delivery + tax and never looked at the
// service charge, so £1.64 of real money was missing from the headline on
// every marketplace order that carries one.
//
// And net was gross-minus-discount, which counted BOTH pass-throughs as revenue
// the shop had earned. The delivery fee is collected for the courier; the
// service charge is the marketplace's own fee on the customer. Neither reaches
// the shop, and counting them flatters every delivery channel against
// collection.
//
// Gross = everything the customer was charged.
// Net   = what the shop keeps: gross, minus discounts, minus the delivery and
//         service-charge pass-throughs.
//
// For 965460811 that is £17.12 gross and £14.99 net — the food, which is the
// only part of that order Mulgrave was ever going to bank.

type Seed = {
  subtotal: number;
  deliveryFee?: number;
  serviceCharge?: number;
  taxAmount?: number;
  discount?: number;
  orderSource?: string;
  status?: string;
};

function order(seed: Seed) {
  const delivery = seed.deliveryFee ?? 0;
  const service = seed.serviceCharge ?? 0;
  const tax = seed.taxAmount ?? 0;
  const discount = seed.discount ?? 0;
  return {
    id: Math.random().toString(36).slice(2),
    status: seed.status ?? "COMPLETED",
    locationId: "loc-1",
    brandId: "b1",
    orderSource: seed.orderSource ?? "JUST_EAT",
    subtotal: seed.subtotal,
    discount,
    deliveryFee: delivery,
    serviceCharge: service,
    taxAmount: tax,
    total: seed.subtotal + delivery + service + tax - discount,
    paymentMethod: "CARD",
    paymentStatus: "PAID",
    createdAt: new Date("2026-10-07T12:00:00Z"),
    postcode: null,
    items: [],
  };
}

function overviewFor(seeds: Seed[], prev: Seed[] = []) {
  const prisma: any = {
    order: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(seeds.map(order))
        .mockResolvedValueOnce(prev.map(order))
        .mockResolvedValue([]),
    },
    menuChannelAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    location: {
      findMany: jest.fn().mockResolvedValue([{ id: "loc-1", name: "Mulgrave" }]),
    },
    userLocation: { findMany: jest.fn().mockResolvedValue([]) },
    userBrand: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new AnalyticsService(prisma).getOverview("t1", {
    from: new Date("2026-10-07T00:00:00Z"),
    to: new Date("2026-10-08T00:00:00Z"),
    role: "TENANT_OWNER",
  });
}

describe("Analytics revenue — service charge in, delivery pass-through out", () => {
  // The real order, to the penny.
  const jetOrder: Seed = { subtotal: 14.99, deliveryFee: 0.49, serviceCharge: 1.64 };

  it("counts the service charge in gross — it is money the customer paid", async () => {
    const res: any = await overviewFor([jetOrder]);

    // 14.99 + 0.49 + 1.64 = 17.12, which is exactly what the card was charged.
    expect(res.summary.grossRevenue).toBeCloseTo(17.12, 2);
  });

  it("takes delivery AND the service charge back out of net — neither is ours", async () => {
    const res: any = await overviewFor([jetOrder]);

    // 17.12 − 0.49 delivery − 1.64 service = 14.99, the food alone.
    expect(res.summary.netRevenue).toBeCloseTo(14.99, 2);
  });

  it("still reports delivery and service as their own lines", async () => {
    const res: any = await overviewFor([jetOrder]);

    // Removing the pass-throughs from net must not hide them: an operator
    // still needs to see what was collected on someone else's behalf, and the
    // dashboard puts each on its own tile. The service charge in particular was
    // reported by the API but had no tile, so it was invisible on the page
    // even after it started counting towards gross.
    expect(res.summary.deliveryFees).toBeCloseTo(0.49, 2);
    expect(res.summary.serviceCharge).toBeCloseTo(1.64, 2);
  });

  it("applies the same rule to every channel, not just marketplaces", async () => {
    // A direct online order with the same money must report the same way —
    // the shop's own delivery fee is no more "earned" than Just Eat's.
    const direct: any = await overviewFor([{ ...jetOrder, orderSource: "DIRECT" }]);

    expect(direct.summary.grossRevenue).toBeCloseTo(17.12, 2);
    expect(direct.summary.netRevenue).toBeCloseTo(14.99, 2);
  });

  it("subtracts discounts from net as well as the delivery fee", async () => {
    const res: any = await overviewFor([{ ...jetOrder, discount: 6 }]);

    // gross 17.12 − 6 discount − 0.49 delivery − 1.64 service
    expect(res.summary.grossRevenue).toBeCloseTo(17.12, 2);
    expect(res.summary.netRevenue).toBeCloseTo(8.99, 2);
  });

  it("measures the prior period the same way, or the delta arrows lie", async () => {
    // Same order in both windows must read as no change. If the comparison
    // kept the old formula the card would show a jump that never happened.
    const res: any = await overviewFor([jetOrder], [jetOrder]);

    // Assert the prior figures explicitly rather than against the current ones:
    // comparing a value to itself would pass even if BOTH were computed the old
    // way, which is exactly the regression this guards.
    expect(res.summary.prevGrossRevenue).toBeCloseTo(17.12, 2);
    expect(res.summary.prevNetRevenue).toBeCloseTo(14.99, 2);
    expect(res.summary.netRevenue).toBeCloseTo(res.summary.prevNetRevenue, 2);
  });

  it("leaves an order with no delivery or service charge untouched", async () => {
    // A collection order: gross and net differ only by discount, as before.
    const res: any = await overviewFor([{ subtotal: 20 }]);

    expect(res.summary.grossRevenue).toBeCloseTo(20, 2);
    expect(res.summary.netRevenue).toBeCloseTo(20, 2);
  });
});
