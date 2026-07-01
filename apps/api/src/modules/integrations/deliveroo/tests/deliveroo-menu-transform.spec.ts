import {
  buildDeliverooMenu,
  type SrcCategory,
} from "../deliveroo-menu.transformer";

// The transformer is the riskiest piece of the direct menu publish: Deliveroo
// models modifier GROUPS as `modifiers[]` and modifier OPTIONS as `items[]`
// with type CHOICE, prices are integer pence, names are `{en}` objects, and a
// menu needs an all-covering mealtime or nothing shows. Verified against the
// Menu API upload reference.

const catWithBurger = (): SrcCategory => ({
  id: "cat-1",
  name: "Burgers",
  description: "Flame grilled",
  products: [
    {
      id: "item-1",
      name: "Cheeseburger",
      description: "Classic",
      price: 7.5,
      plu: "CB1",
      imageUrl: "https://img/cb.jpg",
      available: true,
      groups: [
        {
          id: "grp-1",
          name: "Sauce",
          selectionType: "VARIANT",
          minSelections: 1,
          maxSelections: 1,
          allowDuplicateSelections: false,
          options: [
            { id: "opt-1", name: "Ketchup", price: 0, plu: "K1" },
            { id: "opt-2", name: "Mayo", price: 0.5 },
          ],
        },
      ],
    },
  ],
});

describe("buildDeliverooMenu", () => {
  it("maps categories/items/modifiers into Deliveroo's shape", () => {
    const { payload, stats } = buildDeliverooMenu({
      menuName: "Main Menu",
      siteId: "site-99",
      categories: [catWithBurger()],
    });

    expect(payload.name).toBe("Main Menu");
    expect(payload.site_ids).toEqual(["site-99"]);
    expect(stats).toEqual({ categories: 1, products: 1, groups: 1, options: 2 });

    // Category references the product id.
    expect(payload.menu.categories).toEqual([
      {
        id: "cat-1",
        name: { en: "Burgers" },
        description: { en: "Flame grilled" },
        item_ids: ["item-1"],
      },
    ]);

    // Product is an ITEM with pence price + modifier_ids → group.
    const product = payload.menu.items.find((i) => i.id === "item-1")!;
    expect(product).toMatchObject({
      id: "item-1",
      type: "ITEM",
      name: { en: "Cheeseburger" },
      description: { en: "Classic" },
      plu: "CB1",
      tax_rate: "20", // unconfigured → default UK VAT
      price_info: { price: 750 },
      image: { url: "https://img/cb.jpg" },
      modifier_ids: ["grp-1"],
    });

    // Options are CHOICE items with pence prices + required plu/tax_rate.
    const mayo = payload.menu.items.find((i) => i.id === "opt-2")!;
    expect(mayo).toMatchObject({
      id: "opt-2",
      type: "CHOICE",
      name: { en: "Mayo" },
      plu: "opt-2", // no plu set → falls back to the id
      tax_rate: "20",
      price_info: { price: 50 },
    });

    // Group is a modifier referencing its option ids.
    expect(payload.menu.modifiers).toEqual([
      {
        id: "grp-1",
        name: { en: "Sauce" },
        min_selection: 1,
        max_selection: 1,
        repeatable: false,
        item_ids: ["opt-1", "opt-2"],
      },
    ]);
  });

  it("emits an all-week mealtime covering every non-empty category", () => {
    const { payload } = buildDeliverooMenu({
      menuName: "M",
      siteId: "s",
      categories: [catWithBurger()],
    });
    expect(payload.menu.mealtimes).toHaveLength(1);
    const mt = payload.menu.mealtimes[0]!;
    expect(mt.category_ids).toEqual(["cat-1"]);
    expect(mt.schedule).toHaveLength(7);
    expect(mt.schedule[0]).toEqual({
      day_of_week: 0,
      time_periods: [{ start: "00:00", end: "23:59" }],
    });
  });

  it("emits a shared group/option only once but lists the product under each category", () => {
    const shared = catWithBurger().products[0]!;
    const { payload, stats } = buildDeliverooMenu({
      menuName: "M",
      siteId: "s",
      categories: [
        { id: "cat-1", name: "Burgers", products: [shared] },
        { id: "cat-2", name: "Deals", products: [shared] },
      ],
    });
    // Group + options appear once each.
    expect(stats.products).toBe(1);
    expect(payload.menu.modifiers).toHaveLength(1);
    expect(payload.menu.items.filter((i) => i.id === "item-1")).toHaveLength(1);
    expect(payload.menu.items.filter((i) => i.id === "opt-1")).toHaveLength(1);
    // But both categories list the product.
    expect(payload.menu.categories.map((c) => c.item_ids)).toEqual([
      ["item-1"],
      ["item-1"],
    ]);
  });

  it("skips empty categories and clamps an addon group's max", () => {
    const { payload, warnings } = buildDeliverooMenu({
      menuName: "M",
      siteId: "s",
      categories: [
        { id: "empty", name: "Nothing", products: [] },
        {
          id: "cat-1",
          name: "Extras",
          products: [
            {
              id: "item-1",
              name: "Loaded Fries",
              price: 4,
              groups: [
                {
                  id: "grp-a",
                  name: "Toppings",
                  selectionType: "ADDON",
                  minSelections: 0,
                  maxSelections: null, // → clamp to option count
                  allowDuplicateSelections: true,
                  options: [
                    { id: "o1", name: "Cheese", price: 1 },
                    { id: "o2", name: "Bacon", price: 1.5 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(payload.menu.categories.map((c) => c.id)).toEqual(["cat-1"]);
    expect(warnings.some((w) => w.includes("Nothing"))).toBe(true);
    const grp = payload.menu.modifiers[0]!;
    expect(grp.max_selection).toBe(2); // clamped to number of options
    expect(grp.repeatable).toBe(true);
  });

  it("always sends a non-blank plu + tax_rate (Deliveroo requires both)", () => {
    const { payload } = buildDeliverooMenu({
      menuName: "M",
      siteId: "s",
      categories: [
        {
          id: "c",
          name: "C",
          products: [
            // no plu, explicit 12.5% tax
            { id: "i1", name: "A", price: 5, taxRate: 12.5, groups: [] },
            // no plu, no tax → default 20
            { id: "i2", name: "B", price: 5, groups: [] },
          ],
        },
      ],
    });
    const a = payload.menu.items.find((i) => i.id === "i1")!;
    const b = payload.menu.items.find((i) => i.id === "i2")!;
    expect(a.plu).toBe("i1"); // falls back to id
    expect(a.tax_rate).toBe("12.5");
    expect(b.tax_rate).toBe("20");
    // Every item carries both fields.
    for (const it of payload.menu.items) {
      expect(it.plu).toBeTruthy();
      expect(it.tax_rate).toBeTruthy();
    }
  });

  it("floors negative/garbage prices to 0 pence", () => {
    const { payload } = buildDeliverooMenu({
      menuName: "M",
      siteId: "s",
      categories: [
        {
          id: "c",
          name: "C",
          products: [
            { id: "i", name: "Freebie", price: -3, groups: [] },
          ],
        },
      ],
    });
    expect(payload.menu.items[0]!.price_info.price).toBe(0);
  });
});
