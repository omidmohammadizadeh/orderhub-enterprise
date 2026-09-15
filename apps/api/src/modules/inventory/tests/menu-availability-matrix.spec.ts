import { MenuAvailabilityService } from "../menu-availability.service";

// The 86 board scopes to the brand's most-recently-published menu (any
// channel), falling back to brand-tagged items only before the first publish.
//
// Resolution is assignment-first (Phase BA): a MenuChannelAssignment stamps the
// brand at publish time, so it finds a master/shared/variant menu whose own
// menu.brandId is some other brand. The menu.findFirst below it is the legacy
// fallback for menus published before assignments existed.

function makeService(overrides: {
  /** The menu a serving assignment points at — the primary resolution path. */
  assignedMenu?: any;
  lastPublished?: any;
  categories?: any[];
  taggedItems?: any[];
  items: any[];
}) {
  const prisma = {
    brand: { findFirst: jest.fn().mockResolvedValue({ id: "b1" }) },
    menuChannelAssignment: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides.assignedMenu ? { menu: overrides.assignedMenu } : null,
        ),
    },
    menu: { findFirst: jest.fn().mockResolvedValue(overrides.lastPublished ?? null) },
    menuCategory: {
      findMany: jest.fn().mockResolvedValue(overrides.categories ?? []),
    },
    menuItem: {
      findMany: jest
        .fn()
        // First call = brand-tagged fallback (when used); also the items fetch.
        .mockImplementation(({ where }: any) => {
          // items fetch keys off id: { in: [...] }
          if (where?.id?.in) return Promise.resolve(overrides.items);
          return Promise.resolve(overrides.taggedItems ?? []);
        }),
    },
    menuItemChannelAvailability: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  return new MenuAvailabilityService(prisma, {} as any, {} as any);
}

const item = (id: string, name: string) => ({
  id,
  name,
  plu: null,
  imageUrl: null,
  basePrice: 5,
  hasMultipleSkus: false,
  productSkus: [],
  isAvailable: true,
});

describe("MenuAvailabilityService.getBrandMatrix", () => {
  it("lists the last-published menu's items and reports the source menu", async () => {
    const svc = makeService({
      lastPublished: { id: "menuA", name: "Summer Menu" },
      categories: [
        { items: [{ itemId: "i1" }, { itemId: "i2" }] },
        { items: [{ itemId: "i2" }] }, // dup across categories
      ],
      items: [item("i1", "Burger"), item("i2", "Fries")],
    });

    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.sourceMenu).toEqual({ id: "menuA", name: "Summer Menu" });
    expect(res.items.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  it("prefers the serving assignment over the brand's own menu", async () => {
    // A variant menu owned by another brand but published FOR this one. Before
    // assignments were consulted, the brand-only lookup missed it entirely and
    // the 86 board showed the wrong menu's items.
    const svc = makeService({
      assignedMenu: { id: "menuShared", name: "Master Menu" },
      lastPublished: { id: "menuOwn", name: "Old Own Menu" },
      categories: [{ items: [{ itemId: "i1" }] }],
      items: [item("i1", "Burger")],
    });

    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.sourceMenu).toEqual({ id: "menuShared", name: "Master Menu" });
  });

  it("shows only this brand's items when the menu mixes several brands", async () => {
    // A master menu holds items from several brands. b1's 86 board must not
    // show another brand's products. Asserted on the RESULT, not on the shape
    // of the query: the scoping moved out of SQL and into memory so that a
    // single-brand menu could stop being filtered to nothing (below).
    const svc = makeService({
      lastPublished: { id: "master", name: "Master Menu" },
      categories: [
        { items: [{ itemId: "i1" }, { itemId: "i2" }, { itemId: "i3" }] },
      ],
      items: [
        { ...item("i1", "B1 Burger"), brandId: "b1", brandIds: [] },
        { ...item("i2", "B2 Pizza"), brandId: "b2", brandIds: [] },
        { ...item("i3", "Shared Fries"), brandId: "b2", brandIds: ["b1"] },
      ],
    });

    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.items.map((i: any) => i.id).sort()).toEqual(["i1", "i3"]);
  });

  it("shows every item of a single-brand menu, even under another brand", async () => {
    // The bug the in-memory rule exists for: a menu cloned under one brand but
    // published to SERVE at a location whose brand chip is different. Filtering
    // by brand emptied the board completely and the operator could 86 nothing.
    const svc = makeService({
      lastPublished: { id: "cloned", name: "Cloned Menu" },
      categories: [{ items: [{ itemId: "i1" }, { itemId: "i2" }] }],
      items: [
        { ...item("i1", "Burger"), brandId: "bOther", brandIds: [] },
        { ...item("i2", "Fries"), brandId: "bOther", brandIds: [] },
      ],
    });

    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.items.map((i: any) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  it("falls back to brand-tagged items when the brand has no published menu", async () => {
    const svc = makeService({
      lastPublished: null,
      taggedItems: [{ id: "i9" }],
      items: [item("i9", "Legacy Item")],
    });
    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.sourceMenu).toBeNull();
    expect(res.items.map((i) => i.id)).toEqual(["i9"]);
  });
});
