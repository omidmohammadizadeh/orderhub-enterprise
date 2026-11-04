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

  // The leak this pins: Kingston Pizza's owner carries the parent "Order Hub"
  // brand that 61 shops sit under, and their board was pushed every one of
  // those shops' orders. Rooms carry all orders unfiltered, so a user with
  // their own locations never gains a room through a brand.
  it("never widens a user's own locations with their brands' locations", async () => {
    const prisma = makePrisma({
      tenantLocations: ["kingston", "pizza-uno", "best-kebab"],
      userLocations: ["kingston"],
      userBrands: ["order-hub"],
      brandLocations: { "order-hub": ["pizza-uno", "kingston", "best-kebab"] },
    });
    const ids = await accessibleLocationIdsForRealtime(prisma, {
      tenantId: "t1",
      userId: "ashkan",
      role: "OWNER",
      permissions: [],
    } as any);
    expect(ids).toEqual(["kingston"]);
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

describe("OrdersGateway room:join — a brand never opens another shop's room", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OrdersGateway } = require("../../../infrastructure/socket/gateways/orders.gateway");
  const gatewayWith = (own: string[], brandHits: number) => {
    const gw: any = Object.create(OrdersGateway.prototype);
    gw.prisma = {
      userLocation: { findMany: jest.fn(async () => own.map((locationId) => ({ locationId }))) },
      userBrand: { count: jest.fn(async () => brandHits) },
    };
    return gw;
  };

  it("keeps a user with their own shop out of the parent brand's other shops", async () => {
    const gw = gatewayWith(["kingston"], 1);
    expect(await gw.userCanAccessLocation("ashkan", "OWNER", "pizza-uno")).toBe(false);
    expect(await gw.userCanAccessLocation("ashkan", "OWNER", "kingston")).toBe(true);
    expect(gw.prisma.userBrand.count).not.toHaveBeenCalled();
  });

  it("still lets a brand-only account into its brand's shops", async () => {
    const gw = gatewayWith([], 1);
    expect(await gw.userCanAccessLocation("u9", "OWNER", "l9")).toBe(true);
  });
});
