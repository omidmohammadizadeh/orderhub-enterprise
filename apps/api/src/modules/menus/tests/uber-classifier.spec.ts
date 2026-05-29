import { classifyUberMenu } from "../importers/uber-menu.classifier";

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
