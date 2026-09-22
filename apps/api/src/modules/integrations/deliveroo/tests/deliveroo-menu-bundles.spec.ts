import {
  buildDeliverooMenu,
  menuNameProblems,
  toSrcBundle,
  DELIVEROO_BUNDLE_CATEGORY_ID,
  type SrcBundle,
  type SrcCategory,
  type SrcGroup,
} from "../deliveroo-menu.transformer";

// Meal deals publish as Deliveroo BUNDLEs. The shape (Menu API upload
// reference): a BUNDLE item whose modifier_ids name "bundle-item" sections,
// sections list real ITEMs, and the in-deal price is a MODIFIER override on
// the item keyed by the section. The rules are Deliveroo's own bundle
// guidelines; a deal that breaks one is left out, named, and the menu still
// publishes.

const product = (id: string, name: string, price: number, groups: SrcGroup[] = []) => ({
  id,
  name,
  price,
  groups,
});
const cheese: SrcGroup = {
  id: "grp-cheese",
  name: "Add cheese",
  selectionType: "ADDON",
  options: [{ id: "opt-cheese", name: "Cheese", price: 0.5 }],
};

const menu = (): SrcCategory[] => [
  {
    id: "cat-mains",
    name: "Burgers",
    products: [
      product("burger", "Classic Burger", 9, [cheese]),
      product("veggie", "Veggie Burger", 8),
    ],
  },
  {
    id: "cat-sides",
    name: "Sides",
    products: [
      product("fries", "Fries", 3),
      product("loaded", "Loaded Fries", 4.5),
      product("coke", "Coke", 2),
    ],
  },
];

const deal = (over: Partial<SrcBundle> = {}): SrcBundle => ({
  id: "deal-1",
  name: "Burger Meal",
  price: 12,
  sections: [
    {
      name: "Choose your burger",
      minChoices: 1,
      maxChoices: 1,
      options: [{ productId: "burger" }, { productId: "veggie" }],
    },
    {
      name: "Choose your side",
      minChoices: 1,
      maxChoices: 1,
      options: [{ productId: "fries" }, { productId: "loaded", extraPrice: 1.5 }],
    },
    {
      name: "Choose your drink",
      maxChoices: 1,
      options: [{ productId: "coke" }],
    },
  ],
  ...over,
});

const build = (bundles: SrcBundle[]) =>
  buildDeliverooMenu({
    menuName: "Main",
    siteId: "site-1",
    categories: menu(),
    coverImageUrl: "https://x/cover.jpg",
    bundles,
  });

const item = (r: ReturnType<typeof build>, id: string) =>
  r.payload.menu.items.find((i) => i.id === id)!;

describe("Deliveroo bundles — a valid meal deal", () => {
  const r = build([deal()]);

  it("publishes the deal as a BUNDLE item pointing at its sections", () => {
    expect(item(r, "deal-1")).toMatchObject({
      type: "BUNDLE",
      name: { en: "Burger Meal" },
      price_info: { price: 1200 },
      modifier_ids: ["deal-1__sec0", "deal-1__sec1", "deal-1__sec2"],
    });
    expect(r.stats.bundles).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("models each section as a bundle-item modifier over real menu ITEMs", () => {
    const sec = r.payload.menu.modifiers.find((m) => m.id === "deal-1__sec1")!;
    expect(sec).toEqual({
      id: "deal-1__sec1",
      type: "bundle-item",
      name: { en: "Choose your side" },
      // Deliveroo makes the customer pick the max and validates on the min,
      // so they are published equal.
      min_selection: 1,
      max_selection: 1,
      // An item with extras must not be pickable twice.
      repeatable: false,
      item_ids: ["fries", "loaded"],
    });
    for (const id of sec.item_ids) expect(item(r, id).type).toBe("ITEM");
  });

  it("prices each pick as a MODIFIER override, leaving the item's own price alone", () => {
    expect(item(r, "loaded").price_info).toEqual({
      price: 450, // still £4.50 when bought on its own
      overrides: [{ type: "MODIFIER", id: "deal-1__sec1", price: 150 }],
    });
    expect(item(r, "fries").price_info.overrides).toEqual([
      { type: "MODIFIER", id: "deal-1__sec1", price: 0 },
    ]);
  });

  it("keeps the item's own extras, so a deal burger can still take cheese", () => {
    expect(item(r, "burger").modifier_ids).toEqual(["grp-cheese"]);
  });

  it("puts the deals in a Meal Deals category at the top of the menu", () => {
    expect(r.payload.menu.categories[0]).toEqual({
      id: DELIVEROO_BUNDLE_CATEGORY_ID,
      name: { en: "Meal Deals" },
      item_ids: ["deal-1"],
    });
    expect(r.payload.menu.mealtimes[0]!.category_ids[0]).toBe(DELIVEROO_BUNDLE_CATEGORY_ID);
  });

  it("gives the same item a separate override per section it appears in", () => {
    const two = build([
      deal(),
      deal({
        id: "deal-2",
        name: "Snack Deal",
        price: 4.5,
        sections: [
          { name: "Side", maxChoices: 1, options: [{ productId: "fries" }] },
          { name: "Drink", maxChoices: 1, options: [{ productId: "coke" }] },
        ],
      }),
    ]);
    expect(item(two, "fries").price_info.overrides!.map((o) => o.id)).toEqual([
      "deal-1__sec1",
      "deal-2__sec0",
    ]);
  });
});

describe("Deliveroo bundles — deals that break a rule are left out, by name", () => {
  const refused = (b: SrcBundle) => {
    const r = build([b]);
    expect(item(r, b.id)).toBeUndefined();
    expect(r.stats.bundles).toBe(0);
    // No orphan sections or overrides left behind for Deliveroo to reject.
    expect(r.payload.menu.modifiers.some((m) => m.type === "bundle-item")).toBe(false);
    expect(r.payload.menu.items.some((i) => i.price_info.overrides?.length)).toBe(false);
    // ...and the rest of the menu still goes out.
    expect(item(r, "burger")).toBeDefined();
    expect(r.warnings).toHaveLength(1);
    return r.warnings[0]!;
  };

  it("a deal with no price", () => {
    expect(refused(deal({ price: null }))).toMatch(/Burger Meal.*no price/);
  });

  it("a deal dearer than buying the same items separately", () => {
    // Cheapest no-extra build: Veggie £8 + Fries £3 + Coke £2 = £13.
    expect(refused(deal({ price: 13.5 }))).toMatch(/£13\.50 is more than £13\.00/);
  });

  it("a section with no way to fill it at no extra cost", () => {
    const d = deal();
    d.sections[2] = {
      name: "Choose your drink",
      maxChoices: 1,
      options: [{ productId: "coke", extraPrice: 0.5 }],
    };
    expect(refused(d)).toMatch(/"Choose your drink" asks for 1 pick but only 0 options are included/);
  });

  it("a section asking for more picks than it includes for free", () => {
    const d = deal();
    d.sections[1] = {
      name: "Choose two sides",
      maxChoices: 2,
      options: [{ productId: "fries" }, { productId: "loaded", extraPrice: 1 }],
    };
    expect(refused(d)).toMatch(/asks for 2 picks but only 1 option is included/);
  });

  it("a premium bigger than the item's price over the section's cheapest", () => {
    const d = deal();
    d.sections[1]!.options[1] = { productId: "loaded", extraPrice: 2 }; // headroom £1.50
    expect(refused(d)).toMatch(/"Loaded Fries" costs £2\.00 extra.*at most £1\.50/);
  });

  it("a section whose products are none of them on this menu", () => {
    const d = deal();
    d.sections[2] = { name: "Choose your drink", maxChoices: 1, options: [{ productId: "gone" }] };
    expect(refused(d)).toMatch(/"Choose your drink" has no products that are on this menu/);
  });

  it("a deal with no sections", () => {
    expect(refused(deal({ sections: [] }))).toMatch(/no sections/);
  });
});

describe("Deliveroo bundles — options that can't go in, while the deal still can", () => {
  it("drops a product that isn't on this menu and says so", () => {
    const d = deal();
    d.sections[0]!.options.push({ productId: "not-on-this-menu" });
    const r = build([d]);
    expect(r.stats.bundles).toBe(1);
    expect(r.payload.menu.modifiers.find((m) => m.id === "deal-1__sec0")!.item_ids).toEqual([
      "burger",
      "veggie",
    ]);
    expect(r.warnings).toEqual([
      `Meal deal "Burger Meal": an option in "Choose your burger" isn't on this menu, so it was left out.`,
    ]);
  });

  it("drops a product with more layers of extras than a deal allows", () => {
    // Section (1) + size (2) + crust (3) is Deliveroo's limit; a 4th won't fit.
    const deep: SrcGroup = {
      id: "g1",
      name: "Size",
      options: [
        {
          id: "o1",
          name: "Large",
          price: 0,
          nestedGroups: [
            {
              id: "g2",
              name: "Crust",
              options: [
                {
                  id: "o2",
                  name: "Stuffed",
                  price: 1,
                  nestedGroups: [
                    { id: "g3", name: "Dip", options: [{ id: "o3", name: "Garlic", price: 0 }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const cats = menu();
    cats[0]!.products.push(product("pizza", "Pizza", 8, [deep]));
    const d = deal();
    d.sections[0]!.options.push({ productId: "pizza" });
    const r = buildDeliverooMenu({
      menuName: "Main",
      siteId: "s",
      categories: cats,
      coverImageUrl: "https://x/c.jpg",
      bundles: [d],
    });
    expect(r.stats.bundles).toBe(1);
    expect(r.payload.menu.modifiers.find((m) => m.id === "deal-1__sec0")!.item_ids).not.toContain(
      "pizza",
    );
    expect(r.warnings[0]).toMatch(/"Pizza" has too many layers of extras/);
  });
});

describe("toSrcBundle — reading a stored meal deal", () => {
  const row = {
    id: "deal-9",
    name: "Pizza Deal",
    price: "15.00", // Prisma Decimal arrives as a string
    deliveryTax: "20",
    platformPricingOverrides: {},
    sections: [
      {
        name: "Pizza",
        minChoices: 1,
        maxChoices: 1,
        options: [
          { menuItemId: "p1", priceOverride: null },
          { menuItemId: "p2", priceOverride: "2" },
          { priceOverride: 1 }, // no product — ignored
        ],
      },
    ],
  };

  it("reads the price, tax and sections, treating a blank extra as included", () => {
    expect(toSrcBundle(row)).toMatchObject({
      id: "deal-9",
      price: 15,
      taxRate: 20,
      sections: [
        {
          name: "Pizza",
          options: [
            { productId: "p1", extraPrice: 0 },
            { productId: "p2", extraPrice: 2 },
          ],
        },
      ],
    });
  });

  it("uses the operator's Deliveroo price over the deal's own", () => {
    expect(toSrcBundle({ ...row, platformPricingOverrides: { DELIVEROO: 16.5 } }).price).toBe(16.5);
  });

  it("reads a deal saved before sections existed as having none", () => {
    expect(toSrcBundle({ ...row, sections: undefined }).sections).toEqual([]);
  });
});

it("names a bad deal name as a meal deal, not a product", () => {
  const r = build([deal({ name: "X" })]);
  expect(menuNameProblems(r.payload)).toEqual([
    'Meal deal "X" is too short (1 character, min 2)',
  ]);
});
