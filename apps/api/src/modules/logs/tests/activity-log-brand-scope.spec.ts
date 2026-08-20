import { ActivityLogService } from "../activity-log.service";

// Brand-scoped events carry NO location. A marketing campaign belongs to a
// brand — MarketingCampaign has tenantId and brandId and no locationId — so
// its activity rows are written with locationId null. Filtering the feed on an
// exact locationId therefore hid every promotion create/revoke as soon as a
// location was selected, which is how an Uber certification promotion was run
// and left nothing to export.

function makeService(opts: { brands?: string[]; admin?: boolean } = {}) {
  const queries: any[] = [];
  const prisma = {
    activityLog: {
      findMany: jest.fn(async (args: any) => {
        queries.push(args);
        return [];
      }),
    },
    brand: {
      findMany: jest.fn(async () =>
        (opts.brands ?? ["brand-1"]).map((id) => ({ id })),
      ),
    },
    userLocation: { findMany: jest.fn(async () => [{ locationId: "loc-1" }]) },
    userBrand: { findMany: jest.fn(async () => []) },
  } as any;
  const svc = new ActivityLogService(prisma);
  return { svc, prisma, queries };
}

const ADMIN = { userId: "u1", tenantId: "t1", role: "PLATFORM_ADMIN" };

/** Pull the composed where-clause halves out of the built query. */
function clauses(q: any) {
  const and = q.where.AND;
  return { base: and[0], location: and[1] };
}

describe("ActivityLogService.list — brand-scoped rows under a location filter", () => {
  it("includes null-location rows for brands at the selected location", async () => {
    const { svc, queries } = makeService({ brands: ["brand-1", "brand-2"] });
    await svc.list(ADMIN, { locationId: "loc-1" });

    const { location } = clauses(queries[0]);
    expect(location.OR).toEqual([
      { locationId: "loc-1" },
      { locationId: null, brandId: { in: ["brand-1", "brand-2"] } },
    ]);
  });

  it("composes with AND so the location OR cannot be clobbered", async () => {
    // A sibling OR in the same object literal silently REPLACES this one —
    // the exact shape that leaked every tenant's orders onto the live board
    // (orders.service findLiveOrders, fix 54ab962).
    const { svc, queries } = makeService();
    await svc.list(ADMIN, { locationId: "loc-1", category: "MENU" });

    const q = queries[0];
    expect(Array.isArray(q.where.AND)).toBe(true);
    const { base, location } = clauses(q);
    expect(base.category).toBe("MENU");
    expect(base.tenantId).toBe("t1");
    // The location clause survives alongside the other filters.
    expect(location.OR).toBeDefined();
  });

  it("still narrows to the selected location — no tenant-wide leak", async () => {
    const { svc, queries } = makeService();
    await svc.list(ADMIN, { locationId: "loc-1" });
    const { location } = clauses(queries[0]);
    // Every branch is either that location, or a brand row with no location.
    for (const branch of location.OR) {
      expect(
        branch.locationId === "loc-1" || branch.locationId === null,
      ).toBe(true);
    }
  });

  it("adds no brand branch when the location has no brands", async () => {
    const { svc, queries } = makeService({ brands: [] });
    await svc.list(ADMIN, { locationId: "loc-1" });
    const { location } = clauses(queries[0]);
    expect(location.OR).toEqual([{ locationId: "loc-1" }]);
  });

  it("applies no location clause at all for an unrestricted admin with no filter", async () => {
    const { svc, queries } = makeService();
    await svc.list(ADMIN, {});
    const { location } = clauses(queries[0]);
    expect(location).toEqual({});
  });
});
