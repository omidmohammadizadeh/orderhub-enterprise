import { accessibleLocationIdsForRealtime } from "../order-access";

// The "All locations" Orders board joins no location room at all when it
// has no locationId to join against — so it never received a socket push
// and sat on a 60s-only poll, which read as "I have to refresh to see new
// orders" (the reported symptom). accessibleLocationIdsForRealtime is what
// the socket gateway's room:join-all handler calls to resolve the FULL set
// of rooms to join instead, using the exact same access rule as the REST
// orders endpoint (resolveOrderScope) so realtime visibility never grants
// more, or less, than the board itself would show.

function makePrisma(data: {
  tenantLocations?: string[];
  userLocations?: string[];
  userBrands?: string[];
  brandLocations?: Record<string, string[]>;
}) {
  return {
    location: {
      findMany: jest.fn(async () =>
        (data.tenantLocations ?? []).map((id) => ({ id })),
      ),
    },
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
          locations: (data.brandLocations?.[id] ?? []).map((lid) => ({ id: lid })),
        })),
      ),
    },
  } as any;
}

describe("accessibleLocationIdsForRealtime", () => {
  it("gives a PLATFORM_ADMIN every location in the tenant", async () => {
    const prisma = makePrisma({ tenantLocations: ["l1", "l2", "l3"] });
    const ids = await accessibleLocationIdsForRealtime(prisma, {
      tenantId: "t1",
      userId: "u1",
      role: "PLATFORM_ADMIN",
      permissions: [],
    } as any);
    expect(ids.sort()).toEqual(["l1", "l2", "l3"]);
    // Admin path never touches userLocation/userBrand — it's tenant-wide.
    expect(prisma.userLocation.findMany).not.toHaveBeenCalled();
  });

  it("gives a TENANT_OWNER every location in the tenant too", async () => {
    const prisma = makePrisma({ tenantLocations: ["l1", "l2"] });
    const ids = await accessibleLocationIdsForRealtime(prisma, {
      tenantId: "t1",
      userId: "u1",
      role: "TENANT_OWNER",
      permissions: [],
    } as any);
    expect(ids.sort()).toEqual(["l1", "l2"]);
  });

  it("scopes a MANAGER to only their assigned locations", async () => {
    const prisma = makePrisma({
      tenantLocations: ["l1", "l2", "l3"],
      userLocations: ["l1"],
    });
    const ids = await accessibleLocationIdsForRealtime(prisma, {
      tenantId: "t1",
      userId: "u2",
      role: "MANAGER",
      permissions: [],
    } as any);
    expect(ids).toEqual(["l1"]);
  });

  it("includes locations reached only through a brand assignment", async () => {
    const prisma = makePrisma({
      tenantLocations: ["l1", "l2", "l9"],
      userBrands: ["b1"],
      brandLocations: { b1: ["l9"] },
    });
    const ids = await accessibleLocationIdsForRealtime(prisma, {
      tenantId: "t1",
      userId: "u3",
      role: "OWNER",
      permissions: [],
    } as any);
    expect(ids).toEqual(["l9"]);
  });

  it("returns nothing for a scoped user with no assignments at all", async () => {
    const prisma = makePrisma({ tenantLocations: ["l1", "l2"] });
    const ids = await accessibleLocationIdsForRealtime(prisma, {
      tenantId: "t1",
      userId: "u4",
      role: "STAFF",
      permissions: [],
    } as any);
    expect(ids).toEqual([]);
  });
});
