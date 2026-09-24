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

// A published menu must never leave the board empty.
//
// Live, 24 Sep 2026: the variant menu "kingston pizza-test store" published to
// Just Eat for brand "order hub test store" (JET accepted 118 items), yet the
// Inventory board for that brand read "No published menu for this brand yet".
// The menu mixes several brands' items, so the board scoped to items tagged
// with the selected brand — and none were, because a variant menu's items keep
// the brand they were imported under. The operator then has no way to 86
// anything that is live on Just Eat.
//
// When brand-scoping empties a menu that DOES have items, show the whole menu.
describe("getBrandMatrix — a published menu whose items carry other brands", () => {
  const branded = (id: string, name: string, brandId: string) => ({
    ...item(id, name),
    brandId,
    brandIds: [],
  });

  it("falls back to the whole menu rather than an empty board", async () => {
    const svc = makeService({
      assignedMenu: { id: "menuV", name: "kingston pizza-test store" },
      categories: [{ items: [{ itemId: "i1" }, { itemId: "i2" }] }],
      items: [
        branded("i1", "10\" Munch Box", "otherBrand"),
        branded("i2", "Chips", "thirdBrand"),
      ],
    });

    const res = await svc.getBrandMatrix("b1", "t1");

    expect(res.items.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(res.sourceMenu).toEqual({ id: "menuV", name: "kingston pizza-test store" });
  });

  it("still scopes a master menu that DOES carry this brand's items", async () => {
    const svc = makeService({
      assignedMenu: { id: "menuM", name: "Master Menu" },
      categories: [{ items: [{ itemId: "i1" }, { itemId: "i2" }] }],
      items: [branded("i1", "Ours", "b1"), branded("i2", "Theirs", "otherBrand")],
    });

    const res = await svc.getBrandMatrix("b1", "t1");

    expect(res.items.map((i) => i.id)).toEqual(["i1"]);
  });
});
