import { classifyDeliverooMenu } from "../importers/deliveroo-menu.classifier";

// Deliveroo has no size concept — a 9"/12" pizza is a required single-choice
// modifier group whose options carry the prices. The importer used to hard-code
// `productSkus: []`, so every imported pizza arrived with no sizes and its
// sizes showing up as toppings instead.
//
// The risk in fixing it is over-reach: "Choose your sauce" is also
// pick-exactly-one, and turning sauces into sizes would be worse than the bug.
// These tests pin both directions.

const L = (en: string) => ({ en });

function payload({
  groupName = "Choose a size",
  min = 1,
  max = 1,
  productPrice = 0,
  nestedOnChoice = false,
}: Partial<{
  groupName: string;
  min: number;
  max: number;
  productPrice: number;
  nestedOnChoice: boolean;
}> = {}) {
  return {
    menu: {
      categories: [{ id: "cat1", name: L("Pizzas"), item_ids: ["pizza"] }],
      modifiers: [
        {
          id: "grp-size",
          name: L(groupName),
          item_ids: ["s9", "s12"],
          min_selection: min,
          max_selection: max,
        },
        {
          id: "grp-extras",
          name: L("Extra toppings"),
          item_ids: ["cheese"],
          min_selection: 0,
          max_selection: 5,
        },
      ],
      items: [
        {
          id: "pizza",
          type: "ITEM" as const,
          name: L("Margherita"),
          plu: "MARG",
          price_info: { price: productPrice },
          modifier_ids: ["grp-size", "grp-extras"],
        },
        {
          id: "s9",
          type: "CHOICE" as const,
          name: L('9 inch'),
          plu: "S9",
          price_info: { price: 899 },
        },
        {
          id: "s12",
          type: "CHOICE" as const,
          name: L('12 inch'),
          plu: "S12",
          price_info: { price: 1199 },
        },
        {
          id: "cheese",
          type: "CHOICE" as const,
          name: L("Extra cheese"),
          plu: "CHZ",
          price_info: { price: 150 },
          ...(nestedOnChoice ? { modifier_ids: ["grp-extras"] } : {}),
        },
      ],
    },
  };
}

describe("Deliveroo import — sizes", () => {
  it("turns a required single-choice size group into product SKUs", () => {
    const r = classifyDeliverooMenu(payload() as any);
    const pizza = r.products.find((p) => p.externalId === "pizza")!;

    expect(pizza.hasMultipleSkus).toBe(true);
    expect(pizza.productSkus.map((s) => s.name)).toEqual(["9 inch", "12 inch"]);
    expect(pizza.productSkus.map((s) => s.price)).toEqual([8.99, 11.99]);
    expect(pizza.productSkus.map((s) => s.plu)).toEqual(["S9", "S12"]);
  });

  it("prices the product at its cheapest size when Deliveroo sends 0", () => {
    // Otherwise the menu tile reads "£0.00" and staff think it's broken.
    const r = classifyDeliverooMenu(payload() as any);
    expect(r.products.find((p) => p.externalId === "pizza")!.price).toBe(8.99);
  });

  it("adds the product price to each size, because Deliveroo does", () => {
    // A choice's price is what the marketplace ADDS to the item's, so an item
    // at £10 with a "9 inch +£8.99" charges the customer £18.99. Reading the
    // choice price as the size price undercharges by the item price on every
    // order — and it's how we publish sizes ourselves (base + delta), so a
    // round trip used to come back with a £0.00 smallest size.
    const r = classifyDeliverooMenu(payload({ productPrice: 1000 }) as any);
    const pizza = r.products.find((p) => p.externalId === "pizza")!;
    expect(pizza.productSkus.map((s) => s.price)).toEqual([18.99, 21.99]);
    // The tile shows the cheapest size, which is what the customer sees first.
    expect(pizza.price).toBe(18.99);
  });

  it("reads our own published shape back at the prices we published", () => {
    // The round trip that matters: publish prices the item at its cheapest
    // size and each size at the difference. Importing that must give back the
    // sizes we started with, not the differences.
    const r = classifyDeliverooMenu({
      menu: {
        categories: [{ id: "c", name: L("Pizzas"), item_ids: ["pizza"] }],
        modifiers: [
          {
            id: "pizza__sizes",
            name: L("Size"),
            item_ids: ["pizza__size0", "pizza__size1"],
            min_selection: 1,
            max_selection: 1,
          },
        ],
        items: [
          {
            id: "pizza",
            type: "ITEM",
            name: L("Margherita"),
            plu: "MARG",
            price_info: { price: 899 },
            modifier_ids: ["pizza__sizes"],
          },
          {
            id: "pizza__size0",
            type: "CHOICE",
            name: L("9 inch"),
            plu: "S9",
            price_info: { price: 0 },
          },
          {
            id: "pizza__size1",
            type: "CHOICE",
            name: L("12 inch"),
            plu: "S12",
            price_info: { price: 300 },
          },
        ],
      },
    } as any);

    const pizza = r.products.find((p) => p.externalId === "pizza")!;
    expect(pizza.productSkus.map((s) => s.price)).toEqual([8.99, 11.99]);
  });

  it("keeps non-size groups attached as modifier groups", () => {
    const r = classifyDeliverooMenu(payload() as any);
    const pizza = r.products.find((p) => p.externalId === "pizza")!;

    expect(pizza.modifierGroupExternalIds).toEqual(["grp-extras"]);
    expect(
      r.productModifierGroupLinks.map((l) => l.modifierGroupExternalId),
    ).toEqual(["grp-extras"]);
  });

  it("doesn't also emit the size group as a modifier group", () => {
    const r = classifyDeliverooMenu(payload() as any);
    expect(r.modifierGroups.map((g) => g.externalId)).toEqual(["grp-extras"]);
  });

  it("doesn't also emit the sizes as modifiers", () => {
    // The bug this guards: "12 inch" appearing as a topping AND a size.
    const r = classifyDeliverooMenu(payload() as any);
    expect(r.modifiers.map((m) => m.externalId)).toEqual(["cheese"]);
  });

  it("gives every size the product's other modifier groups", () => {
    // The picker routes a sized product's groups through the SELECTED SKU and
    // ignores the product's own links, so an empty list here means the pizza
    // offers its sizes and not one topping. Six "Choose Size" groups on a real
    // Deliveroo menu meant six products silently losing every option.
    const r = classifyDeliverooMenu(payload() as any);
    const pizza = r.products.find((p) => p.externalId === "pizza")!;

    expect(pizza.productSkus.map((s) => s.modifierGroups)).toEqual([
      ["grp-extras"],
      ["grp-extras"],
    ]);
  });

  it("keeps the size group itself off the SKUs", () => {
    // Otherwise picking 12 inch asks you to pick a size again.
    const r = classifyDeliverooMenu(payload() as any);
    for (const sku of r.products.find((p) => p.externalId === "pizza")!.productSkus) {
      expect(sku.modifierGroups).not.toContain("grp-size");
    }
  });

  it("changes the product hash when the SKU groups change", () => {
    // Products are matched across imports by externalId and skipped when the
    // hash matches. If the groups didn't ride the hash, every product that
    // imported with empty SKU groups would stay broken forever.
    const withGroups = classifyDeliverooMenu(payload() as any).products.find(
      (p) => p.externalId === "pizza",
    )!;
    const noExtras = payload() as any;
    noExtras.menu.items.find((i: any) => i.id === "pizza").modifier_ids = ["grp-size"];
    const without = classifyDeliverooMenu(noExtras).products.find(
      (p) => p.externalId === "pizza",
    )!;

    expect(withGroups.syncHash).not.toBe(without.syncHash);
  });

  it("says in the warnings which group became sizes", () => {
    const r = classifyDeliverooMenu(payload() as any);
    expect(r.warnings.join(" ")).toContain("Choose a size");
  });
});

describe("Deliveroo import — what must NOT become a size", () => {
  it("leaves a single-choice group alone when the name isn't size-like", () => {
    // "Choose your sauce" is pick-exactly-one too. Structure alone would
    // convert it and wreck the menu.
    const r = classifyDeliverooMenu(payload({ groupName: "Choose your sauce" }) as any);
    const pizza = r.products.find((p) => p.externalId === "pizza")!;

    expect(pizza.hasMultipleSkus).toBe(false);
    expect(pizza.productSkus).toEqual([]);
    expect(pizza.modifierGroupExternalIds).toEqual(["grp-size", "grp-extras"]);
  });

  it("leaves an optional group alone even if it mentions size", () => {
    // A size you can skip isn't a size.
    const r = classifyDeliverooMenu(payload({ min: 0 }) as any);
    expect(
      r.products.find((p) => p.externalId === "pizza")!.hasMultipleSkus,
    ).toBe(false);
  });

  it("leaves a multi-select group alone even if it mentions size", () => {
    const r = classifyDeliverooMenu(payload({ max: 3 }) as any);
    expect(
      r.products.find((p) => p.externalId === "pizza")!.hasMultipleSkus,
    ).toBe(false);
  });
});

describe("Deliveroo import — nested modifier groups", () => {
  it("says in the warnings which options open their own groups", () => {
    const r = classifyDeliverooMenu(payload({ nestedOnChoice: true }) as any);
    expect(r.warnings.join(" ")).toMatch(/open their own modifier groups/i);
  });

  it("says nothing when no option has nested groups", () => {
    const r = classifyDeliverooMenu(payload() as any);
    expect(r.warnings.join(" ")).not.toMatch(/open their own modifier groups/i);
  });

  it("emits no nested links for a flat menu", () => {
    expect(classifyDeliverooMenu(payload() as any).optionNestedGroupLinks).toEqual([]);
  });

  // The real shape, from The Grill Stop's Big Boss Burger:
  //
  //   Big Boss Burger
  //   └── Make It a Meal (group)
  //       └── Make It a Meal +£3.99 (option)
  //           ├── Choose Side (group)
  //           │   └── Fries (option)
  //           │       └── Dip (group)
  //           └── Choose Drink (group)
  function mealDealPayload() {
    return {
      menu: {
        categories: [{ id: "cat1", name: L("Burgers"), item_ids: ["burger"] }],
        modifiers: [
          { id: "g-meal", name: L("Make It a Meal"), item_ids: ["o-meal"], min_selection: 0, max_selection: 1 },
          { id: "g-side", name: L("Choose Side"), item_ids: ["o-fries"], min_selection: 1, max_selection: 1 },
          { id: "g-drink", name: L("Choose Drink"), item_ids: ["o-coke"], min_selection: 1, max_selection: 1 },
          { id: "g-dip", name: L("Dip"), item_ids: ["o-mayo"], min_selection: 1, max_selection: 1 },
        ],
        items: [
          { id: "burger", type: "ITEM" as const, name: L("Big Boss Burger"), price_info: { price: 999 }, modifier_ids: ["g-meal"] },
          // Order is load-bearing: side is asked before drink.
          { id: "o-meal", type: "CHOICE" as const, name: L("Make It a Meal"), price_info: { price: 399 }, modifier_ids: ["g-side", "g-drink"] },
          { id: "o-fries", type: "CHOICE" as const, name: L("Fries"), price_info: { price: 0 }, modifier_ids: ["g-dip"] },
          { id: "o-coke", type: "CHOICE" as const, name: L("Coke"), price_info: { price: 0 } },
          { id: "o-mayo", type: "CHOICE" as const, name: L("Garlic Mayo"), price_info: { price: 50 } },
        ],
      },
    };
  }

  it("links an option to every group it opens, in payload order", () => {
    const r = classifyDeliverooMenu(mealDealPayload() as any);
    const meal = r.optionNestedGroupLinks.filter((l) => l.modifierExternalId === "o-meal");

    expect(meal.map((l) => l.modifierGroupExternalId)).toEqual(["g-side", "g-drink"]);
    expect(meal.map((l) => l.sortOrder)).toEqual([0, 1]);
  });

  it("captures the second level of nesting", () => {
    // Fries → Dip. This is the level Deliveroo actually uses and the one
    // that made a meal deal read as complete while behaving as empty.
    const r = classifyDeliverooMenu(mealDealPayload() as any);
    expect(
      r.optionNestedGroupLinks.find((l) => l.modifierExternalId === "o-fries"),
    ).toMatchObject({ modifierGroupExternalId: "g-dip", sortOrder: 0 });
  });

  it("still writes the nested groups and their options as normal rows", () => {
    // The edges are useless if the groups they point at were never created.
    const r = classifyDeliverooMenu(mealDealPayload() as any);
    expect(r.modifierGroups.map((g) => g.externalId).sort()).toEqual([
      "g-dip", "g-drink", "g-meal", "g-side",
    ]);
    expect(r.modifiers.map((m) => m.externalId).sort()).toEqual([
      "o-coke", "o-fries", "o-mayo", "o-meal",
    ]);
  });

  it("leaves the product linked only to its own top-level group", () => {
    // A nested group must NOT also attach to the product, or the burger asks
    // for a side whether or not you made it a meal.
    const r = classifyDeliverooMenu(mealDealPayload() as any);
    expect(
      r.products.find((p) => p.externalId === "burger")!.modifierGroupExternalIds,
    ).toEqual(["g-meal"]);
  });

  it("skips a nested link whose group is missing from the payload", () => {
    // Would otherwise import a picker step that opens nothing.
    const p = mealDealPayload() as any;
    p.menu.items.find((i: any) => i.id === "o-meal").modifier_ids = ["g-side", "g-ghost"];
    const r = classifyDeliverooMenu(p);

    expect(
      r.optionNestedGroupLinks.map((l) => l.modifierGroupExternalId),
    ).not.toContain("g-ghost");
    expect(r.warnings.join(" ")).toMatch(/missing from the menu payload/i);
  });

  it("skips a nested link to a group that became product sizes", () => {
    // The size branch removes that group from the group list, so the link
    // would dangle.
    const p = mealDealPayload() as any;
    p.menu.modifiers.push({
      id: "g-size", name: L("Choose a size"), item_ids: ["s9"], min_selection: 1, max_selection: 1,
    });
    p.menu.items.push({ id: "s9", type: "CHOICE", name: L('9 inch'), price_info: { price: 899 } });
    p.menu.items.find((i: any) => i.id === "burger").modifier_ids = ["g-meal", "g-size"];
    p.menu.items.find((i: any) => i.id === "o-meal").modifier_ids = ["g-side", "g-size"];
    const r = classifyDeliverooMenu(p);

    expect(r.products.find((x) => x.externalId === "burger")!.hasMultipleSkus).toBe(true);
    expect(
      r.optionNestedGroupLinks.map((l) => l.modifierGroupExternalId),
    ).not.toContain("g-size");
  });
});
