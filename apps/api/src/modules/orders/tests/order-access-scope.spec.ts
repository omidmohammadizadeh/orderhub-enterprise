import { OrdersService } from "../orders.service";

// Orders must be scoped to the user's assigned locations AND brands
// (Phase AR team roles). These tests exercise the access-where builder
// directly with a mocked prisma — the client-supplied locationId can only
// NARROW within the allowlist, never widen past it, and "all locations"
// (no locationId) constrains to the user's assignments.

function makeService(data: {
  userLocations?: string[];
  userBrands?: string[];
  brandLocations?: Record<string, string[]>; // brandId → locationIds
}) {
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
  } as any;
  // 10 injected deps — only prisma is exercised here.
  return new OrdersService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

const user = (role: string, extra: Partial<any> = {}) => ({
  userId: "u1",
  tenantId: "t1",
  role,
  permissions: [],
  ...extra,
});

const build = (svc: any, u: any, loc?: string) =>
  svc.resolveOrderAccessWhere(u, loc);

describe("OrdersService order access scoping", () => {
  it("admin roles see the whole tenant (no location/brand restriction)", async () => {
    const svc = makeService({});
    const where = await build(svc, user("TENANT_OWNER"));
    expect(where).toEqual({ tenantId: "t1" });
  });

  it("OWNER is a SCOPED location-owner role (not admin) — limited to assignments", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    const where = await build(svc, user("OWNER"));
    expect(where).toEqual({
      tenantId: "t1",
      OR: [{ locationId: { in: ["l1"] } }],
    });
  });

  it("admin honours an explicit location filter", async () => {
    const svc = makeService({});
    const where = await build(svc, user("PLATFORM_ADMIN"), "locZ");
    expect(where).toEqual({ tenantId: "t1", locationId: "locZ" });
  });

  it("non-admin with no assignments → null (sees nothing, no tenant leak)", async () => {
    const svc = makeService({ userLocations: [], userBrands: [] });
    expect(await build(svc, user("MANAGER"))).toBeNull();
  });

  it("'all locations' constrains a manager to their assigned locations", async () => {
    const svc = makeService({ userLocations: ["l1", "l2"] });
    const where = await build(svc, user("MANAGER"));
    expect(where).toEqual({
      tenantId: "t1",
      OR: [{ locationId: { in: ["l1", "l2"] } }],
    });
  });

  it("a location the user is NOT assigned to is rejected (null)", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    expect(await build(svc, user("MANAGER"), "l2")).toBeNull();
  });

  it("brand-scoped user only sees their brand's orders at the location", async () => {
    // Assigned to brand A (which lives at l1); location comes via the brand.
    const svc = makeService({
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l1"] },
    });
    const where = await build(svc, user("MANAGER"));
    // The brand clause MUST carry its own location bound — see the
    // cross-location leak suite below.
    expect(where).toEqual({
      tenantId: "t1",
      OR: [
        {
          AND: [
            { brandId: { in: ["brandA"] } },
            { locationId: { in: ["l1"] } },
          ],
        },
      ],
    });
  });

  it("brand filter still applies when a single location is selected", async () => {
    const svc = makeService({
      userLocations: ["l1"],
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l1"] },
    });
    const where = await build(svc, user("MANAGER"), "l1");
    // Requesting one location narrows on top of the union.
    expect(where).toEqual({
      tenantId: "t1",
      locationId: "l1",
      OR: [
        { locationId: { in: ["l1"] } },
        {
          AND: [
            { brandId: { in: ["brandA"] } },
            { locationId: { in: ["l1"] } },
          ],
        },
      ],
    });
  });

  it("no UserBrand rows → no brand restriction (all brands at the location)", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    const where = await build(svc, user("MANAGER"), "l1");
    expect(where).toEqual({
      tenantId: "t1",
      locationId: "l1",
      OR: [{ locationId: { in: ["l1"] } }],
    });
    expect((where as any).brandId).toBeUndefined();
  });
});

// ── Cross-location leak (reported live 2026-08-18) ─────────────────────────
//
// A location owner with multiple sites picked "All locations" and saw orders
// from sites that were never assigned to them.
//
// Cause: the brand half of the visibility union was a bare
// `brandId IN (...)` with NO location bound, so an order carrying an
// assigned brand was visible wherever it was placed. That leaks two ways —
// a brand trading at several sites, and a shared marketplace brand (orders
// arriving under a generic brand at unrelated locations).
describe("orders access — brand assignments must not cross locations", () => {
  const clauses = (w: any): any[] => (w?.OR ?? []) as any[];

  it("does not expose a brand's orders at locations the user can't see", async () => {
    // Assigned to brand b1, which trades only at l1. An order for b1 placed
    // at l9 (someone else's site) must not be visible.
    const svc: any = makeService({
      userLocations: ["l1"],
      userBrands: ["b1"],
      brandLocations: { b1: ["l1"] },
    });
    const where = await build(svc, user("OWNER"));

    const brandClause = clauses(where).find((c) => c.AND);
    expect(brandClause).toBeDefined();
    // The brand clause carries a location bound, and l9 isn't in it.
    const locIn = brandClause.AND.find((c: any) => c.locationId)?.locationId?.in;
    expect(locIn).toBeDefined();
    expect(locIn).not.toContain("l9");
    // No clause may match on brand alone.
    for (const c of clauses(where)) {
      if (c.brandId && !c.AND) throw new Error("unbounded brandId clause present");
    }
  });

  it("still shows the whole board at a directly-assigned location", async () => {
    // The regression this union was built to prevent: a marketplace order
    // homed to a DIFFERENT brand, at a location the user owns, must stay
    // visible.
    const svc: any = makeService({ userLocations: ["l1"], userBrands: [] });
    const where = await build(svc, user("OWNER"));

    const direct = clauses(where).find((c) => c.locationId && !c.AND);
    expect(direct.locationId.in).toEqual(["l1"]);
    // Unqualified by brand — every brand trading at l1 shows.
    expect(direct.brandId).toBeUndefined();
  });

  it("shows a brand's orders across its OWN sites", async () => {
    const svc: any = makeService({
      userLocations: [],
      userBrands: ["b1"],
      brandLocations: { b1: ["l1", "l2"] },
    });
    const where = await build(svc, user("OWNER"));

    const brandClause = clauses(where).find((c) => c.AND);
    const locIn = brandClause.AND.find((c: any) => c.locationId)?.locationId?.in;
    expect(locIn).toEqual(expect.arrayContaining(["l1", "l2"]));
  });

  it("returns nothing for a user with no assignments at all", async () => {
    const svc: any = makeService({ userLocations: [], userBrands: [] });
    expect(await build(svc, user("OWNER"))).toBeNull();
  });
});

// ── The live board ignored scoping entirely (reported live 2026-08-18) ─────
//
// findLiveOrders spread `access` (which carries the location/brand scoping in
// an `OR` key) and then declared its own `OR:` for the live-status filter.
// In an object literal the later key wins, so the scoping was silently
// discarded and `tenantId` was the only surviving constraint — every user saw
// every order in the tenant.
//
// These assert the SHAPE of the query the service builds, because that is
// where the bug lived: the scope resolved perfectly and was then thrown away.
describe("live orders — scoping must survive the query build", () => {
  function liveWhere(svc: any): any {
    let captured: any;
    svc.prisma.order = {
      findMany: jest.fn(async (args: any) => {
        captured = args.where;
        return [];
      }),
    };
    svc.prisma.location = { findUnique: jest.fn(async () => ({ timezone: "Europe/London" })) };
    svc.attachCustomerVisitCounts = jest.fn(async (r: any) => r);
    return { run: () => svc.findLiveOrders(user("OWNER")), get: () => captured };
  }

  it("does not let the status filter overwrite the access scoping", async () => {
    const svc: any = makeService({ userLocations: ["l1"] });
    const h = liveWhere(svc);
    await h.run();
    const where = h.get();

    // The scoping must still be reachable somewhere in the built query.
    const asText = JSON.stringify(where);
    expect(asText).toContain("l1");
    // And tenantId alone must never be the whole constraint.
    expect(Object.keys(where)).not.toEqual(["tenantId"]);
  });

  it("still applies the live-status filter", async () => {
    const svc: any = makeService({ userLocations: ["l1"] });
    const h = liveWhere(svc);
    await h.run();

    // Both concerns present: scoping AND the status window.
    const asText = JSON.stringify(h.get());
    expect(asText).toContain("PREPARING");
    expect(asText).toContain("l1");
  });

  it("returns nothing for a user with no assignments", async () => {
    const svc: any = makeService({ userLocations: [], userBrands: [] });
    svc.prisma.order = { findMany: jest.fn(async () => []) };
    await expect(svc.findLiveOrders(user("OWNER"))).resolves.toEqual([]);
    // Must short-circuit — never run an unscoped query.
    expect(svc.prisma.order.findMany).not.toHaveBeenCalled();
  });
});

// Order history (findMany) runs through the same resolveOrderAccessWhere, and
// has the same failure mode the live board once had: the scope resolves
// correctly and is then lost while the rest of the query is built. It also now
// merges a NOT clause for simulated orders, which is exactly the kind of
// addition that quietly clobbers a spread.
//
// Staff, managers, owners and dark-kitchen managers all reach history — it
// carries no @Roles gate — so what stops one shop reading another's takings
// is this scoping and nothing else.
describe("order history — scoping must survive the query build", () => {
  function historyWhere(svc: any, role: string) {
    let captured: any;
    svc.prisma.order = {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async (args: any) => {
        captured = args.where;
        return [];
      }),
    };
    return {
      run: (locationId?: string) =>
        svc.findMany(user(role), { page: 1, limit: 50, locationId }),
      get: () => captured,
    };
  }

  it.each(["STAFF", "MANAGER", "OWNER", "DARK_KITCHEN_MANAGER"])(
    "%s sees history for their own locations",
    async (role) => {
      const svc: any = makeService({ userLocations: ["l1"] });
      const h = historyWhere(svc, role);
      await h.run();
      const asText = JSON.stringify(h.get());
      expect(asText).toContain("l1");
      // tenantId alone would be every shop in the tenant.
      expect(Object.keys(h.get())).not.toEqual(["tenantId"]);
    },
  );

  it.each(["STAFF", "MANAGER", "OWNER", "DARK_KITCHEN_MANAGER"])(
    "%s gets nothing for a location they are not assigned to",
    async (role) => {
      const svc: any = makeService({ userLocations: ["l1"] });
      const h = historyWhere(svc, role);
      const res = await h.run("l2-someone-elses-shop");
      expect(res).toMatchObject({ total: 0, orders: [] });
      // Must short-circuit rather than run an unscoped query.
      expect(svc.prisma.order.findMany).not.toHaveBeenCalled();
    },
  );

  it("returns nothing for a user with no assignments at all", async () => {
    const svc: any = makeService({ userLocations: [], userBrands: [] });
    const h = historyWhere(svc, "STAFF");
    await expect(h.run()).resolves.toMatchObject({ total: 0, orders: [] });
    expect(svc.prisma.order.findMany).not.toHaveBeenCalled();
  });

  it("hides simulated marketplace orders from a non-admin", async () => {
    const svc: any = makeService({ userLocations: ["l1"] });
    const h = historyWhere(svc, "OWNER");
    await h.run();
    expect(JSON.stringify(h.get())).toContain("isSandbox");
  });

  it("shows them to a platform admin", async () => {
    const svc: any = makeService({ userLocations: [] });
    const h = historyWhere(svc, "PLATFORM_ADMIN");
    await h.run();
    expect(JSON.stringify(h.get())).not.toContain("isSandbox");
  });
});
