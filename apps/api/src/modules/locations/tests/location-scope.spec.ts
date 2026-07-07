import { LocationsService } from "../locations.service";

// The location switcher (findAll) must list only the locations a scoped
// user can access: explicit UserLocation rows ∪ the locations their
// assigned brands (UserBrand) operate at. Tenant-wide roles pass no
// userId and see everything. A scoped user with zero assignments sees
// nothing (no tenant-wide fallback). findOne enforces the same scope.

function makeService(data: {
  userLocations?: string[];
  userBrands?: string[];
  brandLocations?: Record<string, string[]>;
  tenantLocations?: Array<{ id: string; name: string }>;
}) {
  const tenantLocs = data.tenantLocations ?? [
    { id: "l1", name: "L1" },
    { id: "l2", name: "L2" },
    { id: "l3", name: "L3" },
  ];
  const prisma = {
    userLocation: {
      findMany: jest.fn(async () =>
        (data.userLocations ?? []).map((locationId) => ({ locationId })),
      ),
    },
    userBrand: {
      findMany: jest.fn(async () =>
        (data.userBrands ?? []).map((brandId) => ({ brandId })),
      ),
    },
    brand: {
      findMany: jest.fn(async () =>
        (data.userBrands ?? []).map((id) => ({
          primaryLocationId: (data.brandLocations?.[id] ?? [])[0] ?? null,
          locations: (data.brandLocations?.[id] ?? []).map((lid) => ({
            id: lid,
          })),
        })),
      ),
    },
    location: {
      findMany: jest.fn(async ({ where }: any) => {
        const allow: string[] | null = where?.id?.in ?? null;
        return tenantLocs
          .filter((l) => !allow || allow.includes(l.id))
          .map((l) => ({ ...l, hubriseCredentials: null }));
      }),
    },
  } as any;
  return new LocationsService(prisma, {} as any);
}

const ids = (rows: any[]) => rows.map((r) => r.id).sort();

describe("LocationsService.findAll scoping (location switcher)", () => {
  it("tenant-wide (no userId) lists every location", async () => {
    const svc = makeService({});
    expect(ids(await svc.findAll("t1"))).toEqual(["l1", "l2", "l3"]);
  });

  it("scoped user sees only their UserLocation rows", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    expect(ids(await svc.findAll("t1", undefined, "u1"))).toEqual(["l1"]);
  });

  it("brand-scoped user (no UserLocation) sees their brand's location", async () => {
    const svc = makeService({
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l2"] },
    });
    expect(ids(await svc.findAll("t1", undefined, "u1"))).toEqual(["l2"]);
  });

  it("unions UserLocation and brand-derived locations", async () => {
    const svc = makeService({
      userLocations: ["l1"],
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l2"] },
    });
    expect(ids(await svc.findAll("t1", undefined, "u1"))).toEqual(["l1", "l2"]);
  });

  it("scoped user with zero assignments sees nothing (no tenant leak)", async () => {
    const svc = makeService({ userLocations: [], userBrands: [] });
    expect(await svc.findAll("t1", undefined, "u1")).toEqual([]);
  });
});

describe("LocationsService.findOne scoping (settings)", () => {
  it("blocks a scoped user from a location they can't access", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    await expect(svc.findOne("l3", "t1", "u1")).rejects.toThrow(
      /not found/i,
    );
  });
});
