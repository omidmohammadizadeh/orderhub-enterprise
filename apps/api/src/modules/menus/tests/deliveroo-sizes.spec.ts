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

  it("leaves a real product price alone", () => {
    const r = classifyDeliverooMenu(payload({ productPrice: 1000 }) as any);
    expect(r.products.find((p) => p.externalId === "pizza")!.price).toBe(10);
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
  it("warns when an option owns its own groups instead of dropping it silently", () => {
    // "Make it a meal" opening a drinks picker. Can't be imported yet, but
    // arriving silently incomplete is what made this hard to spot.
    const r = classifyDeliverooMenu(payload({ nestedOnChoice: true }) as any);
    expect(r.warnings.join(" ")).toMatch(/own modifier groups/i);
  });

  it("says nothing when no option has nested groups", () => {
    const r = classifyDeliverooMenu(payload() as any);
    expect(r.warnings.join(" ")).not.toMatch(/own modifier groups/i);
  });
});
