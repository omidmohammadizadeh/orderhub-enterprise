import { LocationsService } from "../locations.service";

// The location switcher (findAll) must list only the locations a scoped user
// can access. Tenant-wide roles pass no userId and see everything. A scoped
// user with zero assignments sees nothing (no tenant-wide fallback). findOne
// enforces the same scope.
//
// The accessible set is NOT a union. Explicit UserLocation rows are
// authoritative: brand→location expansion applies only to an account with no
// location scope at all. a1c9119a narrowed it for a reason — an OWNER assigned
// to one shop plus "all its brands" could see every location those brands
// trade at.

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

  it("does NOT widen an explicit location scope with brand locations", async () => {
    // The leak a1c9119a closed: this user is assigned to shop l1 and to a
    // brand that also trades at l2. They manage l1, not l2. Their explicit
    // assignment wins and l2 stays hidden.
    const svc = makeService({
      userLocations: ["l1"],
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l2"] },
    });
    expect(ids(await svc.findAll("t1", undefined, "u1"))).toEqual(["l1"]);
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
