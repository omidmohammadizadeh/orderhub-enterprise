// Where a menu publishes into on HubRise.
//
// HubRise allows one catalog per location, so putting each virtual brand on
// its OWN HubRise location is what lets a brand publish its own menu instead
// of everything being merged into a master menu with pricing variants.
//
// The rule these tests protect: brand connection wins when present, and when
// it isn't present the legacy Location path must behave EXACTLY as before —
// including the two rules it learned from a live bug (never publish into a
// deleted location; prefer the menu's own location over any same-brand one).

import { resolveHubRiseTarget } from "../hubrise-target.resolver";

const prismaWith = (opts: {
  connection?: any;
  locationsById?: Record<string, any>;
  brandFallback?: any;
}) => {
  const findFirstLocation = jest.fn(async ({ where, select }: any) => {
    void select;
    if (where.id) {
      const row = opts.locationsById?.[where.id];
      // deletedAt: null is part of the query — a deleted row must not match.
      return row && row.deletedAt == null ? row : null;
    }
    return opts.brandFallback ?? null;
  });
  return {
    prisma: {
      brandPlatformConnection: {
        findFirst: jest.fn(async () => opts.connection ?? null),
      },
      location: { findFirst: findFirstLocation },
    } as any,
    findFirstLocation,
  };
};

const args = { tenantId: "t1", brandId: "b1", locationId: "loc1" };

describe("brand connection wins", () => {
  it("publishes into the brand's own HubRise location and catalog", async () => {
    const { prisma } = prismaWith({
      connection: {
        locationId: "loc1",
        externalStoreId: "hr-loc-brand",
        metadata: { catalogId: "cat-brand", credentials: { enc: "x" } },
      },
    });

    const t = await resolveHubRiseTarget(prisma, args);

    expect(t).toEqual({
      source: "brand",
      locationId: "loc1",
      hubriseLocationId: "hr-loc-brand",
      hubriseCatalogId: "cat-brand",
      hubriseCredentials: { enc: "x" },
    });
  });

  it("never touches the location path when a brand connection exists", async () => {
    // The whole point: a connected brand must not silently fall back to the
    // shared location catalog, which is what produced merged menus.
    const { prisma, findFirstLocation } = prismaWith({
      connection: {
        locationId: "loc1",
        externalStoreId: "hr-loc-brand",
        metadata: { catalogId: "cat-brand" },
      },
      locationsById: { loc1: { id: "loc1", hubriseLocationId: "hr-loc-legacy" } },
    });

    const t = await resolveHubRiseTarget(prisma, args);

    expect(t!.hubriseLocationId).toBe("hr-loc-brand");
    expect(findFirstLocation).not.toHaveBeenCalled();
  });

  it("treats a first-time brand connection (no catalog yet) as publishable", async () => {
    // catalogId is null until the first publish creates one.
    const { prisma } = prismaWith({
      connection: { locationId: "loc1", externalStoreId: "hr-loc", metadata: {} },
    });
    const t = await resolveHubRiseTarget(prisma, args);
    expect(t!.hubriseCatalogId).toBeNull();
    expect(t!.source).toBe("brand");
  });

  it("ignores a connection row with no HubRise location id", async () => {
    // A half-finished connect must not shadow a working location setup.
    const { prisma } = prismaWith({
      connection: { locationId: "loc1", externalStoreId: null, metadata: {} },
      locationsById: {
        loc1: { id: "loc1", hubriseLocationId: "hr-legacy", hubriseCatalogId: "c1" },
      },
    });
    const t = await resolveHubRiseTarget(prisma, args);
    expect(t!.source).toBe("location");
    expect(t!.hubriseLocationId).toBe("hr-legacy");
  });
});

describe("legacy location path is unchanged", () => {
  it("uses the menu's own location when it is connected", async () => {
    const { prisma } = prismaWith({
      locationsById: {
        loc1: { id: "loc1", hubriseLocationId: "hr-own", hubriseCatalogId: "cat-own" },
      },
    });
    const t = await resolveHubRiseTarget(prisma, args);
    expect(t).toMatchObject({
      source: "location",
      locationId: "loc1",
      hubriseLocationId: "hr-own",
      hubriseCatalogId: "cat-own",
    });
  });

  it("falls back to a same-brand connected location when its own isn't", async () => {
    const { prisma } = prismaWith({
      locationsById: { loc1: { id: "loc1", hubriseLocationId: null } },
      brandFallback: { id: "loc2", hubriseLocationId: "hr-other", hubriseCatalogId: "c2" },
    });
    const t = await resolveHubRiseTarget(prisma, args);
    expect(t!.locationId).toBe("loc2");
    expect(t!.hubriseLocationId).toBe("hr-other");
  });

  it("never resolves a DELETED location", async () => {
    // The live bug: publishes 200'd into an orphaned catalog on a deleted
    // location while the order-receiving connection sat elsewhere.
    const { prisma } = prismaWith({
      locationsById: {
        loc1: { id: "loc1", hubriseLocationId: "hr-dead", deletedAt: new Date() },
      },
      brandFallback: { id: "loc2", hubriseLocationId: "hr-live", hubriseCatalogId: "c2" },
    });
    const t = await resolveHubRiseTarget(prisma, args);
    expect(t!.hubriseLocationId).toBe("hr-live");
  });

  it("returns null when nothing is connected, so the caller owns the message", async () => {
    const { prisma } = prismaWith({ locationsById: {} });
    expect(await resolveHubRiseTarget(prisma, args)).toBeNull();
  });
});
