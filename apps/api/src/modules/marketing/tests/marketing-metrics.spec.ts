import { MarketingService } from "../marketing.service";

// Phase MK-INSIGHTS — getMetrics aggregates campaign_redemptions into the
// per-campaign Sales/Orders/New-customers shape the Marketing page shows.
// We mock prisma.campaignRedemption.groupBy: the service calls it twice —
// once for the full slice, once filtered to isNewCustomer.

function makeService(groupByImpl: jest.Mock) {
  const prisma = {
    campaignRedemption: { groupBy: groupByImpl },
  } as any;
  return new MarketingService(prisma, {} as any);
}

describe("MarketingService.getMetrics", () => {
  it("maps grouped rows into orders/sales/discount/newCustomers per campaign", async () => {
    const groupBy = jest.fn(async (args: any) => {
      // Second call is the new-customer-only slice (has isNewCustomer in where).
      if (args.where?.isNewCustomer === true) {
        return [{ campaignId: "c1", _count: { _all: 2 } }];
      }
      return [
        {
          campaignId: "c1",
          _count: { _all: 5 },
          _sum: { orderTotal: 220, discountAmount: 33 },
        },
        {
          campaignId: "c2",
          _count: { _all: 1 },
          _sum: { orderTotal: 44, discountAmount: 0 },
        },
      ];
    });
    const svc = makeService(groupBy);
    const out = await svc.getMetrics({ tenantId: "t1" });

    expect(out.c1).toEqual({
      orders: 5,
      redemptions: 5,
      sales: 220,
      discount: 33,
      newCustomers: 2,
    });
    // c2 has no new-customer rows → 0
    expect(out.c2).toEqual({
      orders: 1,
      redemptions: 1,
      sales: 44,
      discount: 0,
      newCustomers: 0,
    });
  });

  it("passes brand + date-range filters through to the query where-clause", async () => {
    const groupBy = jest.fn(async () => []);
    const svc = makeService(groupBy);
    const from = new Date("2026-07-01T00:00:00Z");
    const to = new Date("2026-07-07T23:59:59Z");
    await svc.getMetrics({ tenantId: "t1", brandId: "b1", from, to });

    const where = groupBy.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.brandId).toBe("b1");
    expect(where.createdAt.gte).toBe(from);
    expect(where.createdAt.lte).toBe(to);
  });

  it("returns an empty map when nothing has been redeemed", async () => {
    const svc = makeService(jest.fn(async () => []));
    expect(await svc.getMetrics({ tenantId: "t1" })).toEqual({});
  });
});
