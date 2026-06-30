import { classifyAiMenu, type AiMenuDraft } from "../importers/ai-menu.classifier";

// ──────────────────────────────────────────────────────────────────────────
// AI menu classifier
//
// Pure-function tests: feed it the structured draft Claude returns from an
// uploaded menu, assert it normalizes the way MenuWriterService expects.
// ──────────────────────────────────────────────────────────────────────────

const draft = (): AiMenuDraft => ({
  menuName: "Pizza Uno",
  currency: "GBP",
  categories: [
    {
      name: "Pizzas",
      items: [
        {
          name: "Margherita",
          description: "Tomato & mozzarella",
          sizes: [
            { name: "10 inch", price: 8.5 },
            { name: "12 inch", price: 10.5 },
          ],
          modifierGroupKeys: ["g_toppings"],
        },
        { name: "Garlic Bread", price: 4 },
      ],
    },
  ],
  modifierGroups: [
    {
      key: "g_toppings",
      name: "Extra toppings",
      selectionType: "ADDON",
      minSelections: 0,
      maxSelections: 3,
      options: [
        { name: "Pepperoni", priceAdjustment: 1.5 },
        { name: "Mushrooms", priceAdjustment: 1 },
      ],
    },
  ],
  warnings: [],
});

describe("classifyAiMenu", () => {
  it("namespaces external ids with the menu id so imports don't collide", () => {
    const n = classifyAiMenu(draft(), "menuABC");
    expect(n.platformSource).toBe("ai");
    expect(n.categories[0].externalId).toBe("menuABC-cat-0");
    expect(n.products[0].externalId).toBe("menuABC-prod-0");
    expect(n.modifierGroups[0].externalId).toBe("menuABC-grp-0");
    expect(n.modifiers[0].externalId).toBe("menuABC-grp-0-opt-0");
  });

  it("maps multi-size items to productSkus with the min size as base price", () => {
    const n = classifyAiMenu(draft(), "m1");
    const pizza = n.products.find((p) => p.name === "Margherita")!;
    expect(pizza.hasMultipleSkus).toBe(true);
    expect(pizza.price).toBe(8.5); // cheapest size
    expect(pizza.productSkus.map((s) => [s.name, s.price])).toEqual([
      ["10 inch", 8.5],
      ["12 inch", 10.5],
    ]);
  });

  it("treats single-price items as flat products", () => {
    const n = classifyAiMenu(draft(), "m1");
    const bread = n.products.find((p) => p.name === "Garlic Bread")!;
    expect(bread.hasMultipleSkus).toBe(false);
    expect(bread.productSkus).toHaveLength(0);
    expect(bread.price).toBe(4);
  });

  it("links items to shared modifier groups by key", () => {
    const n = classifyAiMenu(draft(), "m1");
    const pizza = n.products.find((p) => p.name === "Margherita")!;
    expect(pizza.modifierGroupExternalIds).toEqual(["m1-grp-0"]);
    expect(n.productModifierGroupLinks).toContainEqual({
      productExternalId: pizza.externalId,
      modifierGroupExternalId: "m1-grp-0",
    });
    expect(n.modifierGroupModifierLinks).toHaveLength(2);
    expect(n.modifierGroups[0].modifierExternalIds).toEqual([
      "m1-grp-0-opt-0",
      "m1-grp-0-opt-1",
    ]);
  });

  it("carries ADDON selection semantics through", () => {
    const n = classifyAiMenu(draft(), "m1");
    const g = n.modifierGroups[0];
    expect(g.selectionType).toBe("ADDON");
    expect(g.minSelections).toBe(0);
    expect(g.maxSelections).toBe(3);
    expect(g.allowDuplicateSelections).toBe(true);
  });

  it("drops dangling modifier keys and warns on per-size option pricing", () => {
    const d = draft();
    d.categories[0].items[1].modifierGroupKeys = ["does_not_exist"];
    d.modifierGroups![0].options[0].pricesBySize = [{ sizeName: "12 inch", price: 2 }];
    const n = classifyAiMenu(d, "m1");
    const bread = n.products.find((p) => p.name === "Garlic Bread")!;
    expect(bread.modifierGroupExternalIds).toEqual([]); // dangling key dropped
    // per-size option price is not silently applied — operator is warned
    expect(n.modifiers[0].pricesBySize).toEqual({});
    expect(n.warnings.some((w) => /per size/i.test(w))).toBe(true);
  });
});
