import {
  needsPerSizeExpansion,
  buildSizeGroup,
  sizeBasePrice,
  SIZE_GROUP_NAME,
} from "../shared/publish-sizes";
import { DeliverooMenuPublishService } from "../deliveroo/deliveroo-menu-publish.service";
import { UberEatsMenuPublishService } from "../ubereats/ubereats-menu-publish.service";

// Neither marketplace has sizes. A sized product goes out either as one item
// with a required Size group, or as one item per size — and the choice is a
// constraint, not a taste: no marketplace can price a modifier according to
// another modifier's selection, so a per-size topping price forces the split.

const SKUS = [
  { name: '9 inch', plu: "S9", price: 8.99, modifierGroups: ["g-top"] },
  { name: '12 inch', plu: "S12", price: 11.99, modifierGroups: ["g-top"] },
  { name: '14 inch', plu: "S14", price: 13.99, modifierGroups: ["g-top"] },
];

/** Toppings at one price whatever the size. */
const FLAT = new Map<string, any>([
  ["g-top", { options: [{ pricesBySize: {} }, { pricesBySize: null }] }],
]);

/** Toppings that cost more on a bigger pizza. */
const PER_SIZE = new Map<string, any>([
  ["g-top", { options: [{ pricesBySize: { "9": 0.75, "12": 1.0, "14": 1.25 } }] }],
]);

describe("publish sizes — which shape a sized product takes", () => {
  it("keeps one item when every size prices its modifiers the same", () => {
    expect(needsPerSizeExpansion(SKUS, FLAT)).toBe(false);
  });

  it("splits per size when a modifier is priced by size", () => {
    // The whole reason the per-size-item shape exists: a 14" extra cheese
    // costs more than a 9" one, and that cannot be said once.
    expect(needsPerSizeExpansion(SKUS, PER_SIZE)).toBe(true);
  });

  it("splits per size when sizes offer different groups", () => {
    // "Stuffed crust on 12 inch and up" — marketplaces have no conditional
    // groups, so the only way to say it is separate items.
    const uneven = [
      { ...SKUS[0]!, modifierGroups: ["g-top"] },
      { ...SKUS[1]!, modifierGroups: ["g-top", "g-crust"] },
    ];
    expect(needsPerSizeExpansion(uneven, FLAT)).toBe(true);
  });

  it("ignores the order groups are listed in", () => {
    const reordered = [
      { ...SKUS[0]!, modifierGroups: ["g-top", "g-crust"] },
      { ...SKUS[1]!, modifierGroups: ["g-crust", "g-top"] },
    ];
    expect(needsPerSizeExpansion(reordered, FLAT)).toBe(false);
  });

  it("treats a group the publish can't resolve as flat rather than splitting", () => {
    expect(needsPerSizeExpansion(SKUS, new Map())).toBe(false);
  });

  it("says no for a product with no sizes at all", () => {
    expect(needsPerSizeExpansion([], FLAT)).toBe(false);
  });
});

describe("publish sizes — the Size group", () => {
  it("prices the item at its cheapest size", () => {
    // Marketplaces ADD a modifier's price to the item's, so any other base
    // would need negative options for the cheaper sizes.
    expect(sizeBasePrice(SKUS)).toBe(8.99);
  });

  it("charges each size as its difference from the cheapest", () => {
    const g = buildSizeGroup("item-1", SKUS);
    expect(g.options.map((o) => o.price)).toEqual([0, 3, 5]);
  });

  it("adds up to the real price of each size", () => {
    const base = sizeBasePrice(SKUS);
    const g = buildSizeGroup("item-1", SKUS);
    g.options.forEach((o, i) => {
      expect(base + o.price).toBeCloseTo(Number(SKUS[i]!.price), 2);
    });
  });

  it("is a required pick-one", () => {
    // A size you can skip would let a customer order a pizza of no size.
    const g = buildSizeGroup("item-1", SKUS);
    expect(g).toMatchObject({
      name: SIZE_GROUP_NAME,
      minSelections: 1,
      maxSelections: 1,
      selectionType: "VARIANT",
    });
  });

  it("carries each size's own PLU so an order can be reconciled", () => {
    const g = buildSizeGroup("item-1", SKUS);
    expect(g.options.map((o) => o.plu)).toEqual(["S9", "S12", "S14"]);
  });

  it("uses ids that don't churn between publishes", () => {
    expect(buildSizeGroup("item-1", SKUS)).toEqual(
      buildSizeGroup("item-1", SKUS),
    );
    expect(buildSizeGroup("item-1", SKUS).id).toBe("item-1__sizes");
  });
});

// Both publishers share these Src* types and now this decision, so the same
// menu must come out the same shape on either marketplace.
describe.each([
  ["Deliveroo", DeliverooMenuPublishService],
  ["Uber Eats", UberEatsMenuPublishService],
])("%s publisher — sized products", (_name, Service: any) => {
  const svc = Object.create(Service.prototype);

  const item = {
    id: "item-1",
    name: "Margherita",
    description: null,
    basePrice: 8.99,
    plu: "MARG",
    deliveryTax: 0,
    imageUrl: null,
    isAvailable: true,
  };
  const link = { item, priceOverride: null };
  const call = (skus: any[], groups: Map<string, any>) =>
    svc.toSrcProducts(
      link,
      new Map([["item-1", skus]]),
      new Map(),
      groups,
      null,
    );

  const flatGroups = new Map<string, any>([
    [
      "g-top",
      {
        id: "g-top",
        name: "Toppings",
        selectionType: "ADDON",
        minSelections: 0,
        maxSelections: 3,
        options: [
          { id: "o-cheese", name: "Extra cheese", priceAdjustment: 1, deliveryTax: 0, isAvailable: true },
        ],
      },
    ],
  ]);

  it("publishes one item with a Size group when prices are flat", () => {
    const out = call(SKUS, flatGroups);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Margherita");
    expect(out[0].price).toBe(8.99);
    expect(out[0].groups.map((g: any) => g.name)).toEqual([
      SIZE_GROUP_NAME,
      "Toppings",
    ]);
  });

  it("leaves the shared groups unsuffixed on the single item", () => {
    // Only the per-size shape needs a copy of each group per size.
    const out = call(SKUS, flatGroups);
    const toppings = out[0].groups.find((g: any) => g.name === "Toppings");
    expect(toppings.id).toBe("g-top");
    expect(toppings.options[0].id).toBe("o-cheese");
  });

  it("still splits into one item per size when a topping is priced by size", () => {
    const perSize = new Map<string, any>([
      [
        "g-top",
        {
          ...flatGroups.get("g-top"),
          options: [
            {
              id: "o-cheese",
              name: "Extra cheese",
              priceAdjustment: 1,
              pricesBySize: { "9": 0.75, "12": 1.0, "14": 1.25 },
              deliveryTax: 0,
              isAvailable: true,
            },
          ],
        },
      ],
    ]);
    const out = call(SKUS, perSize);
    expect(out).toHaveLength(3);
    expect(out.map((p: any) => p.name)).toEqual([
      "Margherita - 9 inch",
      "Margherita - 12 inch",
      "Margherita - 14 inch",
    ]);
    // Each size charges its own topping price — the reason for the split.
    expect(out.map((p: any) => p.groups[0].options[0].price)).toEqual([
      0.75, 1.0, 1.25,
    ]);
  });

  it("leaves a product with no sizes completely alone", () => {
    const out = svc.toSrcProducts(
      link,
      new Map(),
      new Map([["item-1", []]]),
      new Map(),
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("item-1");
  });
});
