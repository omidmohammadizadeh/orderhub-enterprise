import { classifyDeliverooMenu } from "../importers/deliveroo-menu.classifier";

// ──────────────────────────────────────────────────────────────────────────
// Phase AK — Deliveroo menu classifier
// ──────────────────────────────────────────────────────────────────────────

const fixture = (): any => ({
  menu: {
    items: [
      // Product 1
      {
        id: "item1",
        type: "ITEM",
        name: "Margherita",
        description: "Classic",
        plu: "PIZZA-1",
        price_info: { price: 999 },
        modifier_ids: ["mg1", "mg2"],
        available: true,
      },
      // Product 2 — no modifier_ids (testing fragility warning)
      {
        id: "item2",
        type: "ITEM",
        name: "Pepperoni",
        plu: "PIZZA-2",
        price_info: { price: 1299 },
        available: true,
      },
      // Modifier option 1
      {
        id: "choice1",
        type: "CHOICE",
        name: "Extra cheese",
        plu: "TOP-CHEESE",
        price_info: { price: 50 },
        available: true,
      },
      // Modifier option 2
      {
        id: "choice2",
        type: "CHOICE",
        name: "Olives",
        price_info: { price: 75 },
      },
    ],
    categories: [
      { id: "cat1", name: "Pizzas", item_ids: ["item1", "item2"] },
    ],
    modifiers: [
      {
        id: "mg1",
        name: "Toppings",
        item_ids: ["choice1", "choice2"],
        min_selection: 0,
        max_selection: 3,
        repeatable: true,
      },
      {
        id: "mg2",
        name: "Crust",
        item_ids: ["choice1"],
        min_selection: 1,
        max_selection: 1,
      },
    ],
  },
});

describe("classifyDeliverooMenu", () => {
  it("classifies CHOICE-type items as modifiers and ITEM-type as products", () => {
    const result = classifyDeliverooMenu(fixture());
    expect(result.products.map((p) => p.externalId).sort()).toEqual(["item1", "item2"]);
    expect(result.modifiers.map((m) => m.externalId).sort()).toEqual([
      "choice1",
      "choice2",
    ]);
  });

  it("parses integer prices as pence (>= 100) and decimal prices as pounds", () => {
    const result = classifyDeliverooMenu(fixture());
    expect(result.products.find((p) => p.externalId === "item1")?.price).toBe(9.99);
    expect(result.modifiers.find((m) => m.externalId === "choice1")?.priceAdjustment).toBe(0.5);
  });

  it("handles small modifier prices (< £1) correctly", () => {
    const result = classifyDeliverooMenu(fixture());
    // choice1 has price 50 = 50p = £0.50, choice2 has 75 = £0.75
    expect(result.modifiers.find((m) => m.externalId === "choice1")?.priceAdjustment).toBe(0.5);
    expect(result.modifiers.find((m) => m.externalId === "choice2")?.priceAdjustment).toBe(0.75);
  });

  it("falls back to item.id when PLU missing", () => {
    const result = classifyDeliverooMenu(fixture());
    expect(result.modifiers.find((m) => m.externalId === "choice2")?.plu).toBe("choice2");
  });

  it("maps modifier group selection type from max_selection", () => {
    const result = classifyDeliverooMenu(fixture());
    expect(result.modifierGroups.find((g) => g.externalId === "mg1")?.selectionType).toBe("ADDON");
    expect(result.modifierGroups.find((g) => g.externalId === "mg2")?.selectionType).toBe("VARIANT");
  });

  it("captures repeatable as allowDuplicateSelections", () => {
    const result = classifyDeliverooMenu(fixture());
    const toppings = result.modifierGroups.find((g) => g.externalId === "mg1");
    expect(toppings?.allowDuplicateSelections).toBe(true);
    const crust = result.modifierGroups.find((g) => g.externalId === "mg2");
    expect(crust?.allowDuplicateSelections).toBe(false);
  });

  it("collects product → modifier group links", () => {
    const result = classifyDeliverooMenu(fixture());
    const item1Links = result.productModifierGroupLinks.filter(
      (l) => l.productExternalId === "item1",
    );
    expect(item1Links.map((l) => l.modifierGroupExternalId).sort()).toEqual(["mg1", "mg2"]);
  });

  it("surfaces a warning when most products have no modifier_ids", () => {
    // Two products, one without modifier_ids = 50% — under threshold.
    // Bump to >50% by removing modifier_ids from item1 too.
    const payload = fixture();
    delete payload.menu.items[0].modifier_ids;
    const result = classifyDeliverooMenu(payload);
    expect(result.warnings.some((w) => w.includes("modifier_ids"))).toBe(true);
  });

  it("syncHash is stable for identical inputs", () => {
    const a = classifyDeliverooMenu(fixture());
    const b = classifyDeliverooMenu(fixture());
    expect(a.menuPatch.syncHash).toBe(b.menuPatch.syncHash);
  });

  it("coerces localised name/description objects to plain strings", () => {
    // The live Deliveroo menu API returns { en: "…" } objects, not strings.
    const payload: any = {
      menu: {
        categories: [{ id: "c1", name: { en: "Wraps" }, item_ids: ["p1"] }],
        items: [
          {
            id: "p1",
            type: "ITEM",
            name: { en: "Chicken Gyros Wrap" },
            description: { en: "Tasty" },
            price_info: { price: 999 },
            modifier_ids: ["mg1"],
          },
          { id: "o1", type: "CHOICE", name: { en: "Extra Cheese" }, price_info: { price: 50 } },
        ],
        modifiers: [{ id: "mg1", name: { en: "Toppings" }, item_ids: ["o1"] }],
      },
    };
    const r = classifyDeliverooMenu(payload);
    expect(r.products[0]!.name).toBe("Chicken Gyros Wrap");
    expect(r.products[0]!.description).toBe("Tasty");
    expect(r.categories[0]!.name).toBe("Wraps");
    expect(r.modifierGroups[0]!.name).toBe("Toppings");
    expect(r.modifiers[0]!.name).toBe("Extra Cheese");
  });
});
