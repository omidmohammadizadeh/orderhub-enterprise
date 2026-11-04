import { CareemMenuPublishService } from "../careem-menu-publish.service";

// The menu a connection sends. Sizes are the part Careem have no concept of, and
// the part a menu built only from item.basePrice silently gets wrong.

const pizza = {
  id: "pizza",
  name: "Margherita",
  basePrice: 0,
  hasMultipleSkus: true,
  productSkus: [
    { name: '10"', plu: "a", price: 30, modifierGroups: ["toppings"] },
    { name: '12"', plu: "b", price: 40, modifierGroups: ["toppings"] },
  ],
  visibleToCustomers: true,
  isAvailable: true,
};
const coke = {
  id: "coke",
  name: "Coke",
  basePrice: 5,
  visibleToCustomers: true,
  isAvailable: true,
};
const hidden = { id: "secret", name: "Staff meal", basePrice: 1, visibleToCustomers: false };

const conn = {
  id: "conn-1",
  tenantId: "t",
  brandId: "brand-1",
  locationId: "loc-1",
  externalStoreId: "branch-1",
  status: "pending",
  metadata: {},
};

const build = (over: { items?: unknown[]; snoozed?: string[]; conns?: unknown[]; variant?: unknown } = {}) => {
  const links = (over.items ?? [pizza, coke, hidden]).map((item, i) => ({ item, sortOrder: i }));
  const prisma: any = {
    menu: { findFirst: jest.fn().mockResolvedValue({ id: "menu-1", name: "Main", brandId: "brand-1", locationId: "loc-1" }) },
    location: { findFirst: jest.fn().mockResolvedValue({ country: "AE" }) },
    menuCategory: {
      findMany: jest.fn().mockResolvedValue([
        { id: "cat-1", name: "Food", sortOrder: 0, items: links },
        { id: "cat-empty", name: "Nothing", sortOrder: 1, items: [] },
      ]),
    },
    menuItemChannelAvailability: {
      findMany: jest.fn().mockResolvedValue((over.snoozed ?? []).map((itemId) => ({ itemId }))),
    },
    modifierGroupOnItem: { findMany: jest.fn().mockResolvedValue([]) },
    modifierGroup: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "toppings",
          name: "Toppings",
          minSelections: 0,
          maxSelections: 2,
          isRequired: false,
          sortOrder: 0,
          selectionType: "ADDON",
          options: [
            { id: "ham", name: "Ham", priceAdjustment: 2, pricesBySize: { "10": 2, "12": 3 }, isAvailable: true, sortOrder: 0, nestedGroupLinks: [] },
          ],
        },
      ]),
    },
    brandPlatformConnection: {
      findMany: jest.fn().mockResolvedValue(over.conns ?? [conn]),
      findFirst: jest.fn().mockResolvedValue(conn),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const client = { request: jest.fn().mockResolvedValue({ request_id: "req-9" }) };
  const variantResolver = { forBrandChannel: jest.fn().mockResolvedValue(over.variant ?? null) };
  const activity = { record: jest.fn() };
  const store = { publishHoursFor: jest.fn().mockResolvedValue({ ok: true }) };
  return {
    svc: new CareemMenuPublishService(
      prisma,
      client as never,
      variantResolver as never,
      activity as never,
      store as never,
    ),
    prisma,
    client,
    variantResolver,
    activity,
    store,
  };
};

const preview = async (ctx: ReturnType<typeof build>) =>
  (await ctx.svc.previewConnection("t", "conn-1", "menu-1")) as any;

describe("CareemMenuPublishService: the catalog", () => {
  it("publishes a sized product as a required Size group priced from the cheapest", async () => {
    const { payload } = await preview(build());
    const item = payload.items.find((i: any) => i.id === "pizza");
    expect(item.price).toBe(30);
    expect(item.groups).toEqual(["pizza__size"]);

    const size = payload.groups.find((g: any) => g.id === "pizza__size");
    expect(size).toMatchObject({ min: 1, max: 1, multi_select: false });
    const options = payload.options.filter((o: any) => size.options.includes(o.id));
    expect(options.map((o: any) => [o.name, o.price])).toEqual([
      ['10"', 0],
      ['12"', 10],
    ]);
  });

  it("copies a group for a size whose prices differ from the default", async () => {
    const { payload } = await preview(build());
    const ids = payload.options.map((o: any) => [o.id, o.price]);
    expect(ids).toEqual(expect.arrayContaining([["ham", 2], ["ham__12", 3]]));
    const twelve = payload.options.find((o: any) => o.id === "pizza__size1");
    expect(twelve.groups).toEqual(["toppings__12"]);
  });

  it("leaves out hidden items and empty categories, and targets the branch", async () => {
    const { payload } = await preview(build());
    expect(payload.items.map((i: any) => i.id)).toEqual(["pizza", "coke"]);
    expect(payload.categories.map((c: any) => c.id)).toEqual(["cat-1"]);
    expect(payload.catalog.id).toBe("branch-1");
  });

  it("publishes an item 86'd on Careem as inactive", async () => {
    const { payload } = await preview(build({ snoozed: ["coke"] }));
    expect(payload.items.find((i: any) => i.id === "coke").active).toBe(false);
  });

  it("uses the brand's Careem prices", async () => {
    const variant = {
      appliesToItem: () => true,
      itemPrice: (i: any) => (i.id === "coke" ? 7 : undefined),
      skuPrice: () => undefined,
      optionPrice: () => undefined,
    };
    const ctx = build({ variant });
    const { payload } = await preview(ctx);
    expect(ctx.variantResolver.forBrandChannel).toHaveBeenCalledWith({ brandId: "brand-1", channel: "CAREEM" });
    expect(payload.items.find((i: any) => i.id === "coke").price).toBe(7);
  });

  it("refuses a decimal price and names the item", async () => {
    const res = await build({ items: [{ ...coke, basePrice: 5.5 }] }).svc.previewConnection("t", "conn-1", "menu-1");
    expect(res.wouldPublish).toBe(false);
    expect(res.problems[0]!.message).toMatch(/"Coke" costs 5.5/);
  });

  it("refuses a menu with nothing customers can see", async () => {
    const res = await build({ items: [hidden] }).svc.previewConnection("t", "conn-1", "menu-1");
    expect(res.wouldPublish).toBe(false);
  });
});

describe("CareemMenuPublishService.publishMenu", () => {
  it("sends to the brand's branch and records what went out", async () => {
    const { svc, client, prisma } = build();
    const res = await svc.publishMenu({ tenantId: "t", menuId: "menu-1", locationId: "loc-1", brandId: "brand-1" });
    expect(res).toMatchObject({ ok: true, requestId: "req-9" });
    expect(client.request).toHaveBeenCalledWith(
      "/catalogs",
      expect.objectContaining({ method: "PUT", branchId: "branch-1", brandId: "brand-1" }),
    );
    const saved = prisma.brandPlatformConnection.update.mock.calls[0][0].data.metadata.careemCatalog;
    expect(saved).toMatchObject({ status: "PROCESSING", requestId: "req-9", itemIds: ["pizza", "coke"] });
  });

  it("sends the hours with it, the first moment Careem will take them", async () => {
    const { svc, store } = build();
    await svc.publishMenu({ tenantId: "t", menuId: "menu-1" });
    expect(store.publishHoursFor).toHaveBeenCalledWith("t", {
      branchId: "branch-1",
      brandId: "brand-1",
      locationId: "loc-1",
    });
  });

  it("still reports the menu as sent if the hours then fail", async () => {
    const { svc, store, activity } = build();
    store.publishHoursFor.mockRejectedValue(new Error("nope"));
    await expect(svc.publishMenu({ tenantId: "t", menuId: "menu-1" })).resolves.toMatchObject({ ok: true });
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hours.publish", status: "ERROR" }),
    );
  });

  it("does not send hours when the menu itself was refused", async () => {
    const { svc, store } = build({ items: [hidden] });
    await svc.publishMenu({ tenantId: "t", menuId: "menu-1" });
    expect(store.publishHoursFor).not.toHaveBeenCalled();
  });

  it("says so when the brand isn't connected here", async () => {
    await expect(
      build({ conns: [] }).svc.publishMenu({ tenantId: "t", menuId: "menu-1" }),
    ).rejects.toThrow(/isn't connected/);
  });

  it("asks which location when the brand is on Careem at several", async () => {
    await expect(
      build({ conns: [conn, { ...conn, id: "conn-2" }] }).svc.publishMenu({ tenantId: "t", menuId: "menu-1", locationId: undefined }),
    ).rejects.toThrow(/more than one location/);
  });

  it("holds to Careem's two-minute floor per branch", async () => {
    const { svc } = build();
    await svc.publishMenu({ tenantId: "t", menuId: "menu-1" });
    await expect(svc.publishMenu({ tenantId: "t", menuId: "menu-1" })).rejects.toThrow(/every 2 minutes/);
  });
});

describe("CareemMenuPublishService.recordCatalogStatus", () => {
  const withCatalog = (requestId: string) => {
    const ctx = build();
    ctx.prisma.brandPlatformConnection.findFirst.mockResolvedValue({
      ...conn,
      metadata: { careemCatalog: { requestId, status: "PROCESSING", itemIds: ["a"] } },
    });
    return ctx;
  };

  it("marks the current request complete, keeping its item ids", async () => {
    const { svc, prisma } = withCatalog("124712");
    await svc.recordCatalogStatus({ request_id: 124712, status: "COMPLETED", vendor_branch_id: "branch-1" });
    const saved = prisma.brandPlatformConnection.update.mock.calls[0][0].data.metadata.careemCatalog;
    expect(saved).toMatchObject({ status: "COMPLETED", itemIds: ["a"] });
  });

  it("ignores the verdict on an older push", async () => {
    const { svc, prisma } = withCatalog("200");
    await svc.recordCatalogStatus({ request_id: 100, status: "FAILED", vendor_branch_id: "branch-1" });
    expect(prisma.brandPlatformConnection.update).not.toHaveBeenCalled();
  });
});
