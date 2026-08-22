import { classifyAiMenu } from "../importers/ai-menu.classifier";

// A scraped pizza menu prices bases, crusts and toppings PER SIZE: a 10" and a
// 16" carry different groups entirely. Attaching the union at item level would
// ask the customer to choose a base three times, so the size has to carry its
// own groups — which the writer already supports via productSkus[].
const draft: any = {
  categories: [
    {
      name: "Pizzas",
      items: [
        {
          name: "Margherita Pizza",
          sizes: [
            { name: '10"', price: 5.8, modifierGroupKeys: ["g_base10"] },
            { name: '16"', price: 13.0, modifierGroupKeys: ["g_base16"] },
          ],
        },
      ],
    },
  ],
  modifierGroups: [
    {
      key: "g_base10",
      name: '10" - Base',
      selectionType: "VARIANT",
      options: [{ name: "Tomato base" }],
    },
    {
      key: "g_base16",
      name: '16" - Base',
      selectionType: "VARIANT",
      options: [{ name: "Tomato base" }],
    },
  ],
};

describe("classifyAiMenu — per-size modifier groups", () => {
  it("gives each size its OWN groups rather than the union", () => {
    const n = classifyAiMenu(draft, "ns");
    const skus = n.products[0]!.productSkus;
    expect(skus).toHaveLength(2);
    expect(skus[0]!.modifierGroups).toHaveLength(1);
    expect(skus[1]!.modifierGroups).toHaveLength(1);
    // Different groups — the 10" base is not the 16" base.
    expect(skus[0]!.modifierGroups[0]).not.toBe(skus[1]!.modifierGroups[0]);
  });

  it("emits ids the writer can translate, matching the group rows", () => {
    const n = classifyAiMenu(draft, "ns");
    const known = new Set(n.modifierGroups.map((g) => g.externalId));
    for (const sku of n.products[0]!.productSkus) {
      for (const id of sku.modifierGroups) expect(known.has(id)).toBe(true);
    }
  });

  it("leaves a size with no keys empty, so it inherits the product's groups", () => {
    // The writer's documented fallback — every existing draft relies on it.
    const plain: any = {
      categories: [
        {
          name: "Kebabs",
          items: [
            {
              name: "Doner",
              sizes: [
                { name: "Regular", price: 6 },
                { name: "Large", price: 8 },
              ],
              modifierGroupKeys: ["g_sauce"],
            },
          ],
        },
      ],
      modifierGroups: [
        { key: "g_sauce", name: "Sauce", selectionType: "ADDON", options: [{ name: "Chilli" }] },
      ],
    };
    const n = classifyAiMenu(plain, "ns");
    for (const sku of n.products[0]!.productSkus) {
      expect(sku.modifierGroups).toEqual([]);
    }
    // ...and the product still carries the group itself.
    expect(n.products[0]!.modifierGroupExternalIds).toHaveLength(1);
  });

  it("ignores a size key that names no group, rather than emitting a dangling id", () => {
    const bad = JSON.parse(JSON.stringify(draft));
    bad.categories[0].items[0].sizes[0].modifierGroupKeys = ["g_nope"];
    const n = classifyAiMenu(bad, "ns");
    expect(n.products[0]!.productSkus[0]!.modifierGroups).toEqual([]);
  });
});
