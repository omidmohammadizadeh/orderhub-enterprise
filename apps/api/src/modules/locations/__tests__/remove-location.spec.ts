import { LocationsService } from "../locations.service";

// A brand anchored to exactly one location (Brand.primaryLocationId) used to
// survive that location's deletion as a dangling "franchise parent" — its FK
// got nulled but the row lived on, invisible in any location's own Brands
// drawer yet still matching the "show everywhere" rule used by brand pickers
// elsewhere (e.g. Team Roles' assign-role brand list). This covers the fix:
// an anchored brand with no footprint elsewhere is removed along with its
// location; one that's genuinely still in use is only unanchored, as before.

function buildPrismaMock(overrides: {
  anchoredBrands: Array<{ id: string }>;
  otherLocationCount: number;
  menuCount: number;
  orderCount: number;
}) {
  const calls: Record<string, any[]> = {
    brandUpdate: [],
    locationDelete: [],
  };
  const tx = {
    location: {
      count: jest.fn().mockResolvedValue(overrides.otherLocationCount),
      delete: jest.fn((args: any) => {
        calls.locationDelete.push(args);
        return Promise.resolve(args);
      }),
    },
    brand: {
      findMany: jest.fn().mockResolvedValue(overrides.anchoredBrands),
      update: jest.fn((args: any) => {
        calls.brandUpdate.push(args);
        return Promise.resolve(args);
      }),
    },
    menu: { count: jest.fn().mockResolvedValue(overrides.menuCount) },
    order: { count: jest.fn().mockResolvedValue(overrides.orderCount) },
  };
  const prisma = {
    location: {
      findFirst: jest.fn().mockResolvedValue({ id: "loc-1", deletedAt: null }),
    },
    order: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  return { prisma, calls };
}

describe("removing a location cleans up brands anchored only to it", () => {
  it("soft-deletes a brand that was anchored to this location and used nowhere else", async () => {
    const { prisma, calls } = buildPrismaMock({
      anchoredBrands: [{ id: "brand-orphan" }],
      otherLocationCount: 0,
      menuCount: 0,
      orderCount: 0,
    });
    const svc = new LocationsService(prisma as any, {} as any, {} as any);

    const result = await svc.remove("loc-1", "tenant-1");

    expect(result).toEqual({ hardDeleted: true, orderCount: 0 });
    expect(calls.brandUpdate).toHaveLength(1);
    expect(calls.brandUpdate[0]).toMatchObject({
      where: { id: "brand-orphan" },
      data: { primaryLocationId: null, deletedAt: expect.any(Date) },
    });
  });

  it("only unanchors a brand that still has other locations, a menu, or orders", async () => {
    const cases = [
      { otherLocationCount: 1, menuCount: 0, orderCount: 0 },
      { otherLocationCount: 0, menuCount: 1, orderCount: 0 },
      { otherLocationCount: 0, menuCount: 0, orderCount: 1 },
    ];
    for (const c of cases) {
      const { prisma, calls } = buildPrismaMock({
        anchoredBrands: [{ id: "brand-in-use" }],
        ...c,
      });
      const svc = new LocationsService(prisma as any, {} as any, {} as any);

      await svc.remove("loc-1", "tenant-1");

      expect(calls.brandUpdate[0]).toMatchObject({
        where: { id: "brand-in-use" },
        data: { primaryLocationId: null },
      });
      expect(calls.brandUpdate[0].data.deletedAt).toBeUndefined();
    }
  });

  it("does nothing brand-related when no brand was anchored to this location", async () => {
    const { prisma, calls } = buildPrismaMock({
      anchoredBrands: [],
      otherLocationCount: 0,
      menuCount: 0,
      orderCount: 0,
    });
    const svc = new LocationsService(prisma as any, {} as any, {} as any);

    await svc.remove("loc-1", "tenant-1");

    expect(calls.brandUpdate).toHaveLength(0);
    expect(calls.locationDelete).toHaveLength(1);
  });
});
