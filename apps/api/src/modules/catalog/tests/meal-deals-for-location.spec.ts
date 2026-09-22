import { CatalogService } from "../catalog.service";

// The Meal Deals tab lists a shop's deals. At a multi-brand shop that has to
// be every brand trading FROM the kitchen, not just Location.brandId — the
// old rule showed one brand's deals and hid the rest. The location's own
// brand stays in: deals made before the tab had a brand picker live there.

function serviceWith(brandsAtLocation: string[]) {
  const mealDealFindMany = jest.fn().mockResolvedValue([]);
  const prisma: any = {
    location: {
      findFirst: jest.fn().mockResolvedValue({ id: "loc-1", brandId: "house" }),
    },
    brand: {
      findMany: jest.fn().mockResolvedValue(brandsAtLocation.map((id) => ({ id }))),
    },
    mealDeal: { findMany: mealDealFindMany },
  };
  return { svc: new CatalogService(prisma), prisma, mealDealFindMany };
}

describe("listMealDealsForLocation", () => {
  it("covers every brand trading from the shop, plus the shop's own brand", async () => {
    const { svc, prisma, mealDealFindMany } = serviceWith(["monster", "pizza-uno"]);
    await svc.listMealDealsForLocation("loc-1", "t1");

    expect(prisma.brand.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "t1",
      deletedAt: null,
      primaryLocationId: "loc-1",
    });
    const where = mealDealFindMany.mock.calls[0][0].where;
    expect(where.brandId.in.sort()).toEqual(["house", "monster", "pizza-uno"]);
  });

  it("still only shows deals for this shop or for every shop", async () => {
    const { svc, mealDealFindMany } = serviceWith([]);
    await svc.listMealDealsForLocation("loc-1", "t1");
    expect(mealDealFindMany.mock.calls[0][0].where.OR).toEqual([
      { locationIds: { isEmpty: true } },
      { locationIds: { has: "loc-1" } },
    ]);
  });

  it("names each deal's brand, since that decides which menu it goes out on", async () => {
    const { svc, mealDealFindMany } = serviceWith([]);
    await svc.listMealDealsForLocation("loc-1", "t1");
    expect(mealDealFindMany.mock.calls[0][0].include).toEqual({
      brand: { select: { id: true, name: true } },
    });
  });

  it("doesn't list the house brand twice when it is also a trading brand", async () => {
    const { svc, mealDealFindMany } = serviceWith(["house"]);
    await svc.listMealDealsForLocation("loc-1", "t1");
    expect(mealDealFindMany.mock.calls[0][0].where.brandId.in).toEqual(["house"]);
  });
});
