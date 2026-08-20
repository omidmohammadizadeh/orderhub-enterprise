import {
  allDayAvailability,
  buildJetMenus,
  toJetAvailability,
  JET_DAYS,
  type JetSrcCategory,
} from "../jet-menu.transformer";

// The menu payload, asserted against JET's schema requirements. The ones that
// actually reject a publish are: every item needs a non-blank `plu`, every
// category needs a `description`, every modifier needs `description` + `pick`,
// prices are integer MINOR units, and all seven availability days must be
// present.

function category(over: Partial<JetSrcCategory> = {}): JetSrcCategory {
  return {
    id: "cat-1",
    name: "Burgers",
    description: "Classic burgers.",
    products: [
      {
        id: "item-1",
        name: "Cheeseburger",
        description: "The classic.",
        price: 15.5,
        plu: "XYZ123",
        groups: [],
      },
    ],
    ...over,
  };
}

const build = (cats: JetSrcCategory[], extra: any = {}) =>
  buildJetMenus({
    menuName: "Summer Menu",
    menuReference: "menu-1",
    categories: cats,
    ...extra,
  });

describe("buildJetMenus — menu envelope", () => {
  it("emits one menu per service type so both channels work", () => {
    // JET's menu `type` is COLLECTION or DELIVERY and a restaurant offering
    // both needs one of each. The food does not change because the customer
    // walked in.
    const { menus, stats } = build([category()]);
    expect(menus.map((m) => m.type).sort()).toEqual(["COLLECTION", "DELIVERY"]);
    expect(stats.menus).toBe(2);
  });

  it("gives each service type its own reference", () => {
    // `reference` is how JET identifies a menu for replacement. One reference
    // for two menus would have the second overwrite the first.
    const { menus } = build([category()]);
    const refs = menus.map((m) => m.reference);
    expect(new Set(refs).size).toBe(2);
    expect(refs).toContain("menu-1-delivery");
    expect(refs).toContain("menu-1-collection");
  });

  it("honours an explicit single service type", () => {
    const { menus } = build([category()], { serviceTypes: ["COLLECTION"] });
    expect(menus).toHaveLength(1);
    expect(menus[0]!.type).toBe("COLLECTION");
  });

  it("sends every schema-required menu field", () => {
    const { menus } = build([category()]);
    for (const menu of menus) {
      expect(menu.name).toBe("Summer Menu");
      expect(menu.reference).toBeTruthy();
      expect(menu.type).toMatch(/^(DELIVERY|COLLECTION)$/);
      expect(Array.isArray(menu.categories)).toBe(true);
      expect(menu.availability).toBeDefined();
    }
  });
});

describe("buildJetMenus — categories and items", () => {
  it("always sends a category description, which the schema requires", () => {
    const { menus } = build([category({ description: null })]);
    expect(menus[0]!.categories[0]!.description).toBe("");
  });

  it("converts prices to integer minor units", () => {
    // £15.50 → 1550. Sending 15.5 would publish a 15p burger.
    const { menus } = build([category()]);
    expect(menus[0]!.categories[0]!.items[0]!.price).toBe(1550);
  });

  it("rounds a price that cannot be represented exactly", () => {
    const { menus } = build([
      category({
        products: [
          { id: "i", name: "x", price: 10.005, plu: "P", groups: [] },
        ],
      }),
    ]);
    expect(Number.isInteger(menus[0]!.categories[0]!.items[0]!.price)).toBe(true);
  });

  it("falls back to the row id when an item has no PLU", () => {
    // JET requires plu on every item, and a cloned menu has its PLUs stripped.
    // The row id is stable AND is the same value the 86 push sends as an
    // itemReference, so an availability update lands on what was published.
    const { menus } = build([
      category({
        products: [
          { id: "item-abc", name: "No PLU", price: 5, plu: "  ", groups: [] },
        ],
      }),
    ]);
    expect(menus[0]!.categories[0]!.items[0]!.plu).toBe("item-abc");
  });

  it("skips an empty category rather than publishing an empty section", () => {
    const { menus, warnings, stats } = build([
      category(),
      category({ id: "cat-2", name: "Empty", products: [] }),
    ]);
    expect(menus[0]!.categories).toHaveLength(1);
    expect(stats.categories).toBe(1);
    expect(warnings.join(" ")).toContain("Empty");
  });

  it("marks a category as a root, never a subcategory", () => {
    // Nested subcategories need a conversation with JET's TPM first, and our
    // graph is flat anyway.
    const { menus } = build([category()]);
    expect(menus[0]!.categories[0]!.type).toBe("root");
    expect(menus[0]!.categories[0]!.categories).toBeUndefined();
  });
});

describe("buildJetMenus — modifiers", () => {
  const withGroup = (min: number, max: number, repeatable = false) =>
    build([
      category({
        products: [
          {
            id: "item-1",
            name: "Burger",
            price: 10,
            plu: "B1",
            groups: [
              {
                id: "g1",
                name: "Cheese",
                description: "Pick a cheese",
                minSelection: min,
                maxSelection: max,
                repeatable,
                options: [
                  { id: "o1", name: "Cheddar", price: 0, plu: "2B" },
                  { id: "o2", name: "Swiss", price: 1, plu: "A2" },
                ],
              },
            ],
          },
        ],
      }),
    ]);

  it("uses `exactly` when min equals max", () => {
    const g = withGroup(1, 1).menus[0]!.categories[0]!.items[0]!.modifiers[0]!;
    expect(g.pick).toEqual({ pick_same_option: false, exactly: 1 });
    expect(g.pick.range).toBeUndefined();
  });

  it("uses `range` when they differ", () => {
    const g = withGroup(0, 3).menus[0]!.categories[0]!.items[0]!.modifiers[0]!;
    expect(g.pick).toEqual({
      pick_same_option: false,
      range: { min: 0, max: 3 },
    });
    expect(g.pick.exactly).toBeUndefined();
  });

  it("treats our 'unlimited' max of 0 as every option selectable", () => {
    // Our editor uses 0 for unlimited; JET has no unlimited, and publishing
    // max 0 would give the customer a group they can never choose from.
    const g = withGroup(0, 0).menus[0]!.categories[0]!.items[0]!.modifiers[0]!;
    expect(g.pick.range).toEqual({ min: 0, max: 2 });
  });

  it("clamps a max below min and says so", () => {
    const built = withGroup(3, 1);
    const g = built.menus[0]!.categories[0]!.items[0]!.modifiers[0]!;
    expect(g.pick).toEqual({ pick_same_option: false, exactly: 3 });
    expect(built.warnings.join(" ")).toContain("clamped");
  });

  it("carries repeatable through as pick_same_option", () => {
    const g = withGroup(1, 3, true).menus[0]!.categories[0]!.items[0]!.modifiers[0]!;
    expect(g.pick.pick_same_option).toBe(true);
  });

  it("prices options in minor units and always gives them a plu", () => {
    const g = withGroup(1, 1).menus[0]!.categories[0]!.items[0]!.modifiers[0]!;
    expect(g.options).toEqual([
      { name: "Cheddar", description: "", plu: "2B", price: 0 },
      { name: "Swiss", description: "", plu: "A2", price: 100 },
    ]);
  });

  it("always sends a modifier description, which the schema requires", () => {
    const built = build([
      category({
        products: [
          {
            id: "i",
            name: "x",
            price: 1,
            plu: "P",
            groups: [
              {
                id: "g",
                name: "G",
                description: null,
                minSelection: 1,
                maxSelection: 1,
                options: [{ id: "o", name: "O", price: 0, plu: "OP" }],
              },
            ],
          },
        ],
      }),
    ]);
    expect(
      built.menus[0]!.categories[0]!.items[0]!.modifiers[0]!.description,
    ).toBe("");
  });
});

describe("buildJetMenus — sizes become portions", () => {
  const sized = build([
    category({
      products: [
        {
          id: "pizza",
          name: "Margherita",
          price: 8,
          plu: "PZ",
          groups: [],
          portions: [
            { id: "pizza__s0", name: "10 inch", price: 8, plu: "PZ10", groups: [] },
            {
              id: "pizza__s1",
              name: "12 inch",
              price: 10,
              plu: "PZ12",
              groups: [
                {
                  id: "crust",
                  name: "Crust",
                  description: "",
                  minSelection: 1,
                  maxSelection: 1,
                  options: [{ id: "c1", name: "Stuffed", price: 3, plu: "CR1" }],
                },
              ],
            },
          ],
        },
      ],
    }),
  ]);

  it("publishes ONE product with a size selector, not one product per size", () => {
    // Deliveroo has no size concept so our publish there flattens to
    // "Margherita - 12 inch". JET has portions, which map 1:1 onto ProductSku,
    // so the customer sees one product — and the 86 board's references stay
    // in agreement with the published menu.
    const items = sized.menus[0]!.categories[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("Margherita");
    expect(items[0]!.portions).toHaveLength(2);
    expect(items[0]!.portions.map((p: any) => p.name)).toEqual([
      "10 inch",
      "12 inch",
    ]);
  });

  it("gives each size its own price and PLU", () => {
    const portions = sized.menus[0]!.categories[0]!.items[0]!.portions;
    expect(portions[0]).toMatchObject({ price: 800, plu: "PZ10" });
    expect(portions[1]).toMatchObject({ price: 1000, plu: "PZ12" });
  });

  it("lets a size carry modifier groups the other size does not", () => {
    // A stuffed crust on the 12" but not the 10" is the case that forces
    // Deliveroo into one-item-per-size. Portions express it natively.
    const portions = sized.menus[0]!.categories[0]!.items[0]!.portions;
    expect(portions[0]!.modifiers).toEqual([]);
    expect(portions[1]!.modifiers[0]!.options[0]).toMatchObject({
      name: "Stuffed",
      price: 300,
    });
  });

  it("counts portions separately from items", () => {
    expect(sized.stats.items).toBe(1);
    expect(sized.stats.portions).toBe(2);
  });
});

describe("buildJetMenus — images and stock", () => {
  it("publishes only absolute, fetchable image URLs", () => {
    // JET's servers pull these, not a browser. A relative or data: URL is a
    // broken image on a live customer page.
    const built = build([
      category({
        products: [
          { id: "a", name: "A", price: 1, plu: "A", groups: [], imageUrl: "https://cdn/x.jpg" },
          { id: "b", name: "B", price: 1, plu: "B", groups: [], imageUrl: "/api/v1/img/2" },
          { id: "c", name: "C", price: 1, plu: "C", groups: [], imageUrl: "data:image/png;base64,AAA" },
        ],
      }),
    ]);
    const items = built.menus[0]!.categories[0]!.items;
    expect(items[0]!.gallery).toEqual([{ url: "https://cdn/x.jpg" }]);
    expect(items[1]!.gallery).toBeUndefined();
    expect(items[2]!.gallery).toBeUndefined();
  });

  it("sends out_of_stock only when true", () => {
    // The 86 board is the live source of availability. Publishing
    // out_of_stock:false over a live suspension would un-86 an item nobody
    // asked to bring back.
    const built = build([
      category({
        products: [
          { id: "a", name: "A", price: 1, plu: "A", groups: [], outOfStock: true },
          { id: "b", name: "B", price: 1, plu: "B", groups: [], outOfStock: false },
        ],
      }),
    ]);
    const items = built.menus[0]!.categories[0]!.items;
    expect(items[0]!.out_of_stock).toBe(true);
    expect("out_of_stock" in items[1]!).toBe(false);
  });
});

describe("toJetAvailability", () => {
  it("always emits all seven days — a missing key is a validation failure", () => {
    const a = toJetAvailability({ monday: [{ from: "09:00", to: "17:00" }] });
    expect(Object.keys(a).sort()).toEqual([...JET_DAYS].sort());
    expect(a.monday).toEqual(["09:00 - 17:00"]);
    // A closed day is an empty array, not an absent key.
    expect(a.sunday).toEqual([]);
  });

  it("reads the day-keyed {enabled, slots} shape", () => {
    const a = toJetAvailability({
      tuesday: { enabled: true, slots: [{ from: "10:00", to: "14:00" }, { from: "17:00", to: "22:00" }] },
      wednesday: { enabled: false, slots: [{ from: "10:00", to: "14:00" }] },
    });
    expect(a.tuesday).toEqual(["10:00 - 14:00", "17:00 - 22:00"]);
    expect(a.wednesday).toEqual([]);
  });

  it("reads the legacy [{day, open, close}] array", () => {
    const a = toJetAvailability([
      { day: "friday", open: "11:00", close: "23:00" },
      { day: "Saturday", open: "11:00", close: "23:59" },
    ]);
    expect(a.friday).toEqual(["11:00 - 23:00"]);
    expect(a.saturday).toEqual(["11:00 - 23:59"]);
  });

  it("ignores junk without losing the rest of the week", () => {
    const a = toJetAvailability({
      monday: [{ from: "09:00", to: "" }, { from: "10:00", to: "12:00" }],
      notaday: [{ from: "1", to: "2" }],
    });
    expect(a.monday).toEqual(["10:00 - 12:00"]);
    expect((a as any).notaday).toBeUndefined();
  });
});

describe("buildJetMenus — availability safety", () => {
  it("publishes all-day rather than a menu nobody can order from", () => {
    // In UK/IE/ES/IT/AU the menu availability ALSO sets opening hours, so an
    // all-closed availability would take the shop off Just Eat entirely.
    const built = build([category()], { availability: toJetAvailability({}) });
    expect(built.menus[0]!.availability.monday).toEqual(["00:00 - 23:59"]);
    expect(built.warnings.join(" ")).toContain("never be orderable");
  });

  it("passes real hours through untouched", () => {
    const availability = toJetAvailability({
      monday: [{ from: "08:00", to: "23:59" }],
    });
    const built = build([category()], { availability });
    expect(built.menus[0]!.availability.monday).toEqual(["08:00 - 23:59"]);
    expect(built.warnings.join(" ")).not.toContain("never be orderable");
  });

  it("allDayAvailability covers every day", () => {
    const a = allDayAvailability();
    expect(JET_DAYS.every((d) => a[d]!.length === 1)).toBe(true);
  });
});
