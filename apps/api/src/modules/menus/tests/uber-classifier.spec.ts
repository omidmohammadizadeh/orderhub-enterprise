import {
  classifyUberMenu,
  groupLinkFieldUsed,
} from "../importers/uber-menu.classifier";

// ──────────────────────────────────────────────────────────────────────────
// Phase AK — Uber menu classifier
//
// Pure-function tests: feed it the kind of payload Uber returns, assert
// it normalizes the way the writer expects. No DB, no HTTP.
// ──────────────────────────────────────────────────────────────────────────

const fixture = (): any => ({
  menus: [
    {
      id: "menu1",
      title: { translations: { en_us: "Main menu" } },
      category_ids: { ids: ["cat1"] },
    },
  ],
  categories: [
    {
      id: "cat1",
      title: { translations: { en_us: "Pizzas" } },
      external_data: "PIZZA-CAT",
      entities: [{ id: "item1" }, { id: "item2" }],
    },
  ],
  items: [
    // Product 1 — flat pizza, two modifier groups
    {
      id: "item1",
      title: { translations: { en_us: "Margherita" } },
      description: { translations: { en_us: "Tomato, mozzarella, basil" } },
      external_data: "MARG-12",
      price_info: { price: 999 },
      modifier_group_ids: { ids: ["mg1", "mg2"] },
      suspension_info: { suspended: false },
    },
    // Product 2 — uses the alternate "option_lists" field
    {
      id: "item2",
      title: { translations: { en_us: "Pepperoni" } },
      external_data: "PEP-12",
      price_info: { price: 1299 },
      option_lists: ["mg1"],
    },
    // Modifier option (referenced by mg1.modifier_options[0])
    {
      id: "opt_extra_cheese",
      title: { translations: { en_us: "Extra cheese" } },
      external_data: "TOP-CHEESE",
      price_info: { price: 50 },
    },
    // Modifier option (mg2)
    {
      id: "opt_olives",
      title: { translations: { en_us: "Black olives" } },
      price_info: { price: 75 },
    },
  ],
  modifier_groups: [
    {
      id: "mg1",
      title: { translations: { en_us: "Toppings" } },
      quantity_info: { quantity: { min_permitted: 0, max_permitted: 3 } },
      modifier_options: [{ id: "opt_extra_cheese" }],
    },
    {
      id: "mg2",
      title: { translations: { en_us: "Crust" } },
      quantity_info: { quantity: { min_permitted: 1, max_permitted: 1 } },
      modifier_options: [{ id: "opt_olives" }],
    },
  ],
});

describe("classifyUberMenu", () => {
  it("splits items into products and modifiers correctly", () => {
    const result = classifyUberMenu(fixture());
    expect(result.products.map((p) => p.externalId).sort()).toEqual(["item1", "item2"]);
    expect(result.modifiers.map((m) => m.externalId).sort()).toEqual([
      "opt_extra_cheese",
      "opt_olives",
    ]);
  });

  it("converts pence prices to pounds", () => {
    const result = classifyUberMenu(fixture());
    const marg = result.products.find((p) => p.externalId === "item1");
    expect(marg?.price).toBe(9.99);
    expect(result.modifiers.find((m) => m.externalId === "opt_extra_cheese")?.priceAdjustment).toBe(0.5);
  });

  it("uses external_data as PLU when present, item.id otherwise", () => {
    const result = classifyUberMenu(fixture());
    expect(result.products.find((p) => p.externalId === "item1")?.plu).toBe("MARG-12");
    expect(result.modifiers.find((m) => m.externalId === "opt_olives")?.plu).toBe("opt_olives");
  });

  it("maps modifier group selection type from max_permitted", () => {
    const result = classifyUberMenu(fixture());
    expect(result.modifierGroups.find((g) => g.externalId === "mg1")?.selectionType).toBe("ADDON");
    expect(result.modifierGroups.find((g) => g.externalId === "mg2")?.selectionType).toBe("VARIANT");
  });

  it("captures min/max selections", () => {
    const result = classifyUberMenu(fixture());
    const toppings = result.modifierGroups.find((g) => g.externalId === "mg1");
    expect(toppings?.minSelections).toBe(0);
    expect(toppings?.maxSelections).toBe(3);
  });

  it("collects product → modifier group links from any of the alternate field names", () => {
    const result = classifyUberMenu(fixture());
    const links = result.productModifierGroupLinks.filter(
      (l) => l.productExternalId === "item1",
    );
    expect(links.map((l) => l.modifierGroupExternalId).sort()).toEqual(["mg1", "mg2"]);

    // item2 uses option_lists (not modifier_group_ids) — must still be picked up.
    const item2Links = result.productModifierGroupLinks.filter(
      (l) => l.productExternalId === "item2",
    );
    expect(item2Links.map((l) => l.modifierGroupExternalId)).toEqual(["mg1"]);
  });

  it("respects suspension_info.suspended", () => {
    const payload = fixture();
    payload.items[0].suspension_info = { suspended: true };
    const result = classifyUberMenu(payload);
    expect(result.products[0].isAvailable).toBe(false);
  });

  it("emits a stable syncHash on the menu and on each entity", () => {
    const a = classifyUberMenu(fixture());
    const b = classifyUberMenu(fixture());
    expect(a.menuPatch.syncHash).toBe(b.menuPatch.syncHash);
    expect(a.products[0].syncHash).toBe(b.products[0].syncHash);
  });

  it("produces different menu syncHashes when the payload changes", () => {
    const a = classifyUberMenu(fixture());
    const changed = fixture();
    changed.items[0].price_info.price = 1099; // bumped price
    const b = classifyUberMenu(changed);
    expect(a.menuPatch.syncHash).not.toBe(b.menuPatch.syncHash);
  });

  it("emits a warning for orphan product → group references", () => {
    const payload = fixture();
    payload.items[0].modifier_group_ids = { ids: ["mg_does_not_exist"] };
    const result = classifyUberMenu(payload);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ── Nested modifier groups ──────────────────────────────────────────────────
//
// An Uber option can carry modifier groups of its own — "Make It a Meal"
// opening a sides picker and a drinks picker. The classifier used to read
// options for name and price only, so a meal deal imported looking complete
// and behaved as if empty: the customer picked "Make It a Meal +£3.99" and
// was never asked which side.

const mealFixture = (): any => ({
  categories: [
    {
      id: "cat1",
      title: { translations: { en_us: "Burgers" } },
      entities: [{ id: "burger" }],
    },
  ],
  items: [
    {
      id: "burger",
      title: { translations: { en_us: "Big Boss Burger" } },
      price_info: { price: 899 },
      modifier_group_ids: { ids: ["mg_meal"] },
    },
    {
      id: "opt_meal",
      title: { translations: { en_us: "Make It a Meal" } },
      price_info: { price: 399 },
      // The nesting: choosing this opens two more groups.
      modifier_group_ids: { ids: ["mg_side", "mg_drink"] },
    },
    { id: "opt_fries", title: { translations: { en_us: "Fries" } }, price_info: { price: 0 } },
    { id: "opt_coke", title: { translations: { en_us: "Coke" } }, price_info: { price: 0 } },
  ],
  modifier_groups: [
    {
      id: "mg_meal",
      title: { translations: { en_us: "Make It a Meal" } },
      quantity_info: { quantity: { min_permitted: 0, max_permitted: 1 } },
      modifier_options: [{ id: "opt_meal" }],
    },
    {
      id: "mg_side",
      title: { translations: { en_us: "Choose Side" } },
      quantity_info: { quantity: { min_permitted: 1, max_permitted: 1 } },
      modifier_options: [{ id: "opt_fries" }],
    },
    {
      id: "mg_drink",
      title: { translations: { en_us: "Choose Drink" } },
      quantity_info: { quantity: { min_permitted: 1, max_permitted: 1 } },
      modifier_options: [{ id: "opt_coke" }],
    },
  ],
});

describe("Uber classifier — nested modifier groups", () => {
  it("links an option to every group it opens, in payload order", () => {
    const r = classifyUberMenu(mealFixture());
    expect(r.optionNestedGroupLinks).toEqual([
      { modifierExternalId: "opt_meal", modifierGroupExternalId: "mg_side", sortOrder: 0 },
      { modifierExternalId: "opt_meal", modifierGroupExternalId: "mg_drink", sortOrder: 1 },
    ]);
  });

  it("still writes the nested groups and their options as normal rows", () => {
    // They're ordinary groups — only the option → group edge is extra.
    const r = classifyUberMenu(mealFixture());
    expect(r.modifierGroups.map((g) => g.externalId)).toEqual(
      expect.arrayContaining(["mg_meal", "mg_side", "mg_drink"]),
    );
    expect(r.modifiers.map((m) => m.externalId)).toEqual(
      expect.arrayContaining(["opt_meal", "opt_fries", "opt_coke"]),
    );
  });

  it("leaves the product linked only to its own top-level group", () => {
    const r = classifyUberMenu(mealFixture());
    expect(r.products[0]!.modifierGroupExternalIds).toEqual(["mg_meal"]);
  });

  it("skips a nested link whose group is missing from the payload", () => {
    const payload = mealFixture();
    payload.items[1].modifier_group_ids = { ids: ["mg_side", "mg_ghost"] };
    const r = classifyUberMenu(payload);
    expect(r.optionNestedGroupLinks.map((l) => l.modifierGroupExternalId)).toEqual(
      ["mg_side"],
    );
    expect(r.warnings.join(" ")).toContain("missing from the menu payload");
  });

  it("emits no nested links for a flat menu", () => {
    expect(classifyUberMenu(fixture()).optionNestedGroupLinks).toEqual([]);
  });

  it("says in the warnings which options open their own groups", () => {
    expect(classifyUberMenu(mealFixture()).warnings.join(" ")).toContain(
      "Make It a Meal",
    );
  });
});

// ── Sizes ───────────────────────────────────────────────────────────────────

describe("Uber classifier — sizes", () => {
  const sized = (groupName = "Size"): any => ({
    categories: [
      { id: "c", title: { translations: { en_us: "Pizzas" } }, entities: [{ id: "pizza" }] },
    ],
    items: [
      {
        id: "pizza",
        title: { translations: { en_us: "Margherita" } },
        price_info: { price: 800 },
        modifier_group_ids: { ids: ["mg_size"] },
      },
      { id: "s10", title: { translations: { en_us: "10 inch" } }, external_data: "M10", price_info: { price: 0 } },
      { id: "s12", title: { translations: { en_us: "12 inch" } }, external_data: "M12", price_info: { price: 200 } },
    ],
    modifier_groups: [
      {
        id: "mg_size",
        title: { translations: { en_us: groupName } },
        quantity_info: { quantity: { min_permitted: 1, max_permitted: 1 } },
        modifier_options: [{ id: "s10" }, { id: "s12" }],
      },
    ],
  });

  it("lifts a required single-choice size group into product SKUs", () => {
    const r = classifyUberMenu(sized());
    const pizza = r.products[0]!;
    expect(pizza.hasMultipleSkus).toBe(true);
    expect(pizza.productSkus.map((s) => s.name)).toEqual(["10 inch", "12 inch"]);
    expect(pizza.productSkus.map((s) => s.plu)).toEqual(["M10", "M12"]);
  });

  it("adds the item price to each size, because Uber does", () => {
    // Uber ADDS a modifier's price to the item's, so a "12 inch +£2.00" on an
    // £8.00 item charges £10.00. Reading the choice price as the size price
    // would undercharge by the item price on every order.
    const r = classifyUberMenu(sized());
    expect(r.products[0]!.productSkus.map((s) => s.price)).toEqual([8, 10]);
  });

  it("doesn't leave the size group as a modifier group as well", () => {
    const r = classifyUberMenu(sized());
    expect(r.modifierGroups).toHaveLength(0);
    expect(r.products[0]!.modifierGroupExternalIds).toEqual([]);
  });

  it("doesn't list the sizes as modifiers as well", () => {
    expect(classifyUberMenu(sized()).modifiers).toHaveLength(0);
  });

  it("leaves a single-choice group alone when the name isn't size-like", () => {
    // "Choose your sauce" is also pick-exactly-one. Turning sauces into sizes
    // would wreck a menu far more visibly than missing a size group.
    const r = classifyUberMenu(sized("Choose your sauce"));
    expect(r.products[0]!.hasMultipleSkus).toBe(false);
    expect(r.modifierGroups.map((g) => g.externalId)).toEqual(["mg_size"]);
  });
});

// ── The field Uber's Get Menu actually uses ─────────────────────────────────
//
// Publishing writes `modifier_group_ids`. Reading the same store back gives
// items keyed [id, external_data, title, price_info, tax_info, dish_info,
// product_info, bundled_items] — the links come home in `bundled_items`, and
// we were probing `bundled_item_ids`, a field no payload has ever had.
//
// Every product, group and option imported correctly on its own and none of
// them were joined to anything: pizzas with no toppings, sizes with no
// crusts. Nothing in the import log said so.

describe("Uber classifier — group links via bundled_items", () => {
  const viaBundled = (): any => ({
    categories: [
      { id: "c", title: { translations: { en_us: "Pizzas" } }, entities: [{ id: "pizza" }] },
    ],
    items: [
      {
        id: "pizza",
        external_data: "MARG",
        title: { translations: { en_us: "Margharita" } },
        price_info: { price: 800 },
        tax_info: {},
        dish_info: {},
        product_info: {},
        bundled_items: ["mg_size", "mg_top"],
      },
      {
        id: "s10",
        external_data: "M10",
        title: { translations: { en_us: "10 inch" } },
        price_info: { price: 0 },
        bundled_items: ["mg_crust"],
      },
      { id: "s12", external_data: "M12", title: { translations: { en_us: "12 inch" } }, price_info: { price: 200 } },
      { id: "o_cheese", title: { translations: { en_us: "Extra cheese" } }, price_info: { price: 100 } },
      { id: "o_thin", title: { translations: { en_us: "Thin" } }, price_info: { price: 0 } },
    ],
    modifier_groups: [
      {
        id: "mg_size",
        title: { translations: { en_us: "Size" } },
        quantity_info: { quantity: { min_permitted: 1, max_permitted: 1 } },
        modifier_options: [{ id: "s10" }, { id: "s12" }],
      },
      {
        id: "mg_top",
        title: { translations: { en_us: "Toppings" } },
        quantity_info: { quantity: { min_permitted: 0, max_permitted: 5 } },
        modifier_options: [{ id: "o_cheese" }],
      },
      {
        id: "mg_crust",
        title: { translations: { en_us: "Crust" } },
        quantity_info: { quantity: { min_permitted: 1, max_permitted: 1 } },
        modifier_options: [{ id: "o_thin" }],
      },
    ],
  });

  it("finds the size group and lifts it into SKUs", () => {
    const r = classifyUberMenu(viaBundled());
    expect(r.products[0]!.productSkus.map((s) => s.name)).toEqual([
      "10 inch",
      "12 inch",
    ]);
  });

  it("attaches the product's own groups to every size", () => {
    // The screenshot that started this: three sizes, "0 MODIFIER GROUPS"
    // under each. A sized product routes its groups through the selected
    // SKU, so an empty list here means the pizza offers nothing at all.
    const r = classifyUberMenu(viaBundled());
    for (const sku of r.products[0]!.productSkus) {
      expect(sku.modifierGroups).toContain("mg_top");
    }
  });

  it("gives a size the groups that hang off that size alone", () => {
    const r = classifyUberMenu(viaBundled());
    const [ten, twelve] = r.products[0]!.productSkus;
    expect(ten!.modifierGroups).toEqual(["mg_top", "mg_crust"]);
    expect(twelve!.modifierGroups).toEqual(["mg_top"]);
  });

  it("reports which field the links came from", () => {
    expect(groupLinkFieldUsed(viaBundled().items)).toBe("bundled_items");
    expect(groupLinkFieldUsed([{ id: "x" }])).toBeNull();
  });

  it("accepts object entries as well as bare ids", () => {
    // Same field, seen carrying [{id}] rather than ["id"].
    const payload = viaBundled();
    payload.items[0].bundled_items = [{ id: "mg_size" }, { id: "mg_top" }];
    const r = classifyUberMenu(payload);
    expect(r.products[0]!.productSkus[0]!.modifierGroups).toContain("mg_top");
  });

  it("still prefers modifier_group_ids when Uber does send it", () => {
    const payload = viaBundled();
    payload.items[0].modifier_group_ids = { ids: ["mg_top"] };
    expect(groupLinkFieldUsed(payload.items)).toBe("modifier_group_ids");
  });
});
