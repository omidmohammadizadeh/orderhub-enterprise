import { AutoDispatchService } from "../auto-dispatch.service";

// A location's brands = its own brand, brands homed there, brands whose menu
// is served there, and brands with recent orders there. A rule scoped to a
// location can only name those.

function svc() {
  const prisma: any = {
    location: {
      findFirst: jest.fn(async () => ({ id: "loc1" })),
      findMany: jest.fn(async ({ where }: any) =>
        where?.id?.in
          ? [{ id: "loc1", brandId: "own" }]
          : [{ id: "loc1", name: "Clifton", country: "GB", currency: "GBP" }],
      ),
    },
    brand: {
      count: jest.fn(async ({ where }: any) => where.id.in.length),
      findMany: jest.fn(async ({ where }: any) =>
        where?.primaryLocationId ? [{ id: "homed", primaryLocationId: "loc1" }] : [
          { id: "own", name: "Own" },
          { id: "homed", name: "Homed" },
          { id: "served", name: "Served" },
          { id: "ordered", name: "Ordered" },
          { id: "elsewhere", name: "Elsewhere" },
        ],
      ),
    },
    menuChannelAssignment: { findMany: jest.fn(async () => [{ locationId: "loc1", brandId: "served" }]) },
    order: { groupBy: jest.fn(async () => [{ locationId: "loc1", brandId: "ordered" }]) },
    autoDispatchRule: { create: jest.fn(async ({ data }: any) => data) },
  };
  const none = { getDecrypted: jest.fn(async () => null) };
  return new AutoDispatchService(prisma, {} as any, none as any, {} as any, none as any, {} as any, none as any, {} as any, none as any);
}

const base = { name: "r", strategy: "FIXED", providers: ["JET_GO"], trigger: "ON_ACCEPT" };

describe("auto dispatch — brands at a location", () => {
  it("lists only the brands that trade there", async () => {
    const o = await svc().options("t1");
    expect(o.locations[0].brandIds.sort()).toEqual(["homed", "ordered", "own", "served"]);
  });

  it("accepts a rule naming brands that trade at its location", async () => {
    await expect(
      svc().createRule("t1", null, { ...base, locationId: "loc1", brandIds: ["own", "served"] }),
    ).resolves.toBeTruthy();
  });

  it("refuses a brand that doesn't trade at the rule's location", async () => {
    await expect(
      svc().createRule("t1", null, { ...base, locationId: "loc1", brandIds: ["elsewhere"] }),
    ).rejects.toThrow(/doesn't trade at that location/);
  });
});
