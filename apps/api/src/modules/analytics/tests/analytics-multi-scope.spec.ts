import { AnalyticsService } from "../analytics.service";

// MULTI-SELECT, AND THE BRAND LIST THAT GOES WITH IT.
//
// Two asks from the same screen: pick several shops or brands at once, and stop
// offering all 120 tenant brands when a single shop is in view.
//
// The dangerous half is the first. `locationId` was validated against the
// caller's accessible set; a LIST must be validated the same way, element by
// element, or passing ten ids becomes a way to read shops you were never given.

function harness(opts: {
  scopeIds?: string[] | null;
  assignedBrandIds?: string[];
}) {
  const orderFindMany = jest.fn().mockResolvedValue([]);
  const brandFindMany = jest.fn().mockResolvedValue([]);
  const assignmentFindMany = jest
    .fn()
    .mockResolvedValue((opts.assignedBrandIds ?? []).map((brandId) => ({ brandId })));
  const prisma: any = {
    order: { findMany: orderFindMany },
    brand: { findMany: brandFindMany },
    menuChannelAssignment: { findMany: assignmentFindMany },
    location: { findMany: jest.fn().mockResolvedValue([]) },
    userLocation: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.scopeIds ?? []).map((locationId) => ({ locationId }))),
    },
    userBrand: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, orderFindMany, brandFindMany, assignmentFindMany };
}

async function run(
  h: ReturnType<typeof harness>,
  args: Record<string, unknown>,
) {
  await new AnalyticsService(h.prisma as any)
    .getOverview("t1", {
      from: new Date("2026-10-07T00:00:00Z"),
      to: new Date("2026-10-08T00:00:00Z"),
      ...args,
    } as any)
    .catch(() => undefined);
  return {
    orderWhere: h.orderFindMany.mock.calls[0]?.[0]?.where,
    brandWhere: h.brandFindMany.mock.calls[0]?.[0]?.where,
  };
}

describe("Analytics filters — several locations and brands at once", () => {
  it("queries every selected location, not just the first", async () => {
    const h = harness({});
    const { orderWhere } = await run(h, {
      role: "TENANT_OWNER",
      locationIds: ["loc-1", "loc-2", "loc-3"],
    });

    expect(orderWhere.locationId).toEqual({ in: ["loc-1", "loc-2", "loc-3"] });
  });

  it("queries every selected brand", async () => {
    const h = harness({});
    const { orderWhere } = await run(h, {
      role: "TENANT_OWNER",
      brandIds: ["b1", "b2"],
    });

    expect(orderWhere.brandId).toEqual({ in: ["b1", "b2"] });
  });

  it("still honours the old single-value params, and merges them", async () => {
    // Saved links and the existing UI send `locationId`; both must work, and
    // sending both must not drop either.
    const h = harness({});
    const { orderWhere } = await run(h, {
      role: "TENANT_OWNER",
      locationId: "loc-1",
      locationIds: ["loc-2"],
    });

    expect(orderWhere.locationId).toEqual({ in: ["loc-1", "loc-2"] });
  });

  it("DROPS locations the caller has no access to", async () => {
    // A manager at loc-1 asking for loc-1, loc-2 and loc-9 gets loc-1 only.
    const h = harness({ scopeIds: ["loc-1"] });
    const { orderWhere } = await run(h, {
      role: "POS_MANAGER",
      userId: "u1",
      locationIds: ["loc-1", "loc-2", "loc-9"],
    });

    expect(orderWhere.locationId).toEqual({ in: ["loc-1"] });
  });

  it("returns nothing — never everything — when no requested location is allowed", async () => {
    // The failure mode that matters: falling back to "no filter" would show the
    // whole tenant to someone who asked for one shop they cannot see.
    const h = harness({ scopeIds: ["loc-1"] });
    const { orderWhere } = await run(h, {
      role: "POS_MANAGER",
      userId: "u1",
      locationIds: ["loc-7", "loc-8"],
    });

    expect(orderWhere.locationId).toEqual({ in: ["__no_access__"] });
  });

  it("de-duplicates a repeated id rather than querying it twice", async () => {
    const h = harness({});
    const { orderWhere } = await run(h, {
      role: "TENANT_OWNER",
      locationId: "loc-1",
      locationIds: ["loc-1", "loc-1"],
    });

    expect(orderWhere.locationId).toEqual({ in: ["loc-1"] });
  });
});

describe("Analytics brand picker — only brands that trade at the chosen shop", () => {
  it("offers brands assigned to the location, and ones with orders there", async () => {
    const h = harness({ assignedBrandIds: ["b-assigned"] });
    const { brandWhere } = await run(h, {
      role: "TENANT_OWNER",
      locationIds: ["loc-1"],
    });

    // Assignment OR history: a brand whose assignment was removed still owns
    // its past orders and must stay filterable, or last month's report breaks.
    expect(brandWhere.OR).toEqual([
      { id: { in: ["b-assigned"] } },
      { orders: { some: { tenantId: "t1", locationId: { in: ["loc-1"] } } } },
    ]);
  });

  it("asks the assignment table only about the selected locations", async () => {
    const h = harness({});
    await run(h, { role: "TENANT_OWNER", locationIds: ["loc-1", "loc-2"] });

    expect(h.assignmentFindMany.mock.calls[0][0].where).toEqual({
      locationId: { in: ["loc-1", "loc-2"] },
    });
  });

  it("offers every brand when no location is selected", async () => {
    // "All locations" means all brands — the filter must not disappear here.
    const h = harness({});
    const { brandWhere } = await run(h, { role: "TENANT_OWNER" });

    expect(brandWhere.OR).toBeUndefined();
    expect(brandWhere).toEqual({ tenantId: "t1", deletedAt: null });
  });

  it("scopes the brand list to a manager's own locations, unasked", async () => {
    // No location picked, but a scoped user still must not see brands from
    // shops they have no access to.
    const h = harness({ scopeIds: ["loc-1"] });
    const { brandWhere } = await run(h, { role: "POS_MANAGER", userId: "u1" });

    expect(brandWhere.OR).toBeDefined();
  });
});

describe("Analytics filterOptions — what the pickers are allowed to offer", () => {
  it("hands back the location-scoped brand list for the pickers to use", async () => {
    // The page used to populate the brand picker from the tenant-wide brand
    // list, so scoping to one shop still offered every brand in the group.
    // The overview now reports what is actually on offer for this selection.
    const orderFindMany = jest.fn().mockResolvedValue([]);
    const prisma: any = {
      order: { findMany: orderFindMany },
      brand: {
        findMany: jest.fn().mockResolvedValue([{ id: "b-here", name: "Jinty's" }]),
      },
      menuChannelAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      location: {
        findMany: jest.fn().mockResolvedValue([{ id: "loc-1", name: "Mulgrave" }]),
      },
      userLocation: { findMany: jest.fn().mockResolvedValue([]) },
      userBrand: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const res: any = await new AnalyticsService(prisma).getOverview("t1", {
      from: new Date("2026-10-07T00:00:00Z"),
      to: new Date("2026-10-08T00:00:00Z"),
      role: "TENANT_OWNER",
      locationIds: ["loc-1"],
    } as any);

    expect(res.filterOptions.brands).toEqual([{ id: "b-here", name: "Jinty's" }]);
    expect(res.filterOptions.locations).toEqual([
      { id: "loc-1", name: "Mulgrave" },
    ]);
  });
});

describe("Analytics brand breakdown still has its names", () => {
  it("names a brand in byBrand even though the brand list is now scoped", async () => {
    // The same `brands` query feeds the picker AND the name lookup for the
    // "Sales by brand" table. Narrowing it to the chosen locations must not
    // turn a real brand into "Unassigned" — every brand with orders at those
    // locations is matched by the history half of the OR, and this proves it.
    const prisma: any = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "o1",
            status: "COMPLETED",
            locationId: "loc-1",
            brandId: "b-here",
            orderSource: "JUST_EAT",
            subtotal: 10,
            discount: 0,
            deliveryFee: 0,
            serviceCharge: 0,
            taxAmount: 0,
            total: 10,
            paymentMethod: "CARD",
            paymentStatus: "PAID",
            createdAt: new Date("2026-10-07T12:00:00Z"),
            postcode: null,
            items: [],
          },
        ]),
      },
      brand: {
        findMany: jest.fn().mockResolvedValue([{ id: "b-here", name: "Jinty's" }]),
      },
      menuChannelAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      location: {
        findMany: jest.fn().mockResolvedValue([{ id: "loc-1", name: "Mulgrave" }]),
      },
      userLocation: { findMany: jest.fn().mockResolvedValue([]) },
      userBrand: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const res: any = await new AnalyticsService(prisma).getOverview("t1", {
      from: new Date("2026-10-07T00:00:00Z"),
      to: new Date("2026-10-08T00:00:00Z"),
      role: "TENANT_OWNER",
      locationIds: ["loc-1"],
    } as any);

    expect(res.byBrand).toEqual([
      { id: "b-here", name: "Jinty's", revenue: 10, orders: 1 },
    ]);
  });
});
