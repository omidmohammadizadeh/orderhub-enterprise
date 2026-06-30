import { transformMenuToCatalog } from "../hubrise-catalog.service";

// End-to-end shape check for the HubRise catalog publish: one shared catalog,
// brand×channel variants, per-product brand restrictions, and per-variant
// price_overrides on SKUs + modifier options.

describe("transformMenuToCatalog — brand×channel variants", () => {
  const variants = [
    { ref: "brandA__UBER_EATS", name: "Pizza Uno — Uber Eats", channelKey: "UBER_EATS", brandId: "brandA", brandName: "Pizza Uno" },
    { ref: "brandA__DELIVEROO", name: "Pizza Uno — Deliveroo", channelKey: "DELIVEROO", brandId: "brandA", brandName: "Pizza Uno" },
    { ref: "brandB__UBER_EATS", name: "Monster — Uber Eats", channelKey: "UBER_EATS", brandId: "brandB", brandName: "Monster" },
  ];

  const cheese = {
    id: "o1",
    name: "Extra cheese",
    priceAdjustment: 1,
    isDefault: false,
    // pricier on Uber Eats
    platformPricingOverrides: { brandA__UBER_EATS: 1.5 },
  };
  const toppings = {
    id: "g1",
    name: "Toppings",
    selectionType: "ADDON",
    minSelections: 0,
    maxSelections: 3,
    options: [cheese],
  };
  const groupById = new Map<string, any>([["g1", toppings]]);

  const menu = {
    pricingVariants: variants,
    categories: [
      {
        id: "c1",
        name: "Pizza",
        items: [
          {
            // single-SKU, tagged to Pizza Uno (brandA), Uber Eats priced up
            item: {
              id: "i1",
              name: "Margherita",
              plu: "PIZZA1",
              brandId: "brandA",
              basePrice: 5,
              platformPricingOverrides: { brandA__UBER_EATS: 6 },
              modifierGroupLinks: [{ group: toppings }],
            },
          },
          {
            // multi-SKU, tagged to brandA, per-size Uber override on the 10"
            item: {
              id: "i2",
              name: "Pepperoni",
              brandId: "brandA",
              basePrice: 0,
              hasMultipleSkus: true,
              productSkus: [
                { name: '10"', plu: "P10", price: 8, modifierGroups: ["g1"], priceOverrides: { brandA__UBER_EATS: 9 } },
                { name: '12"', plu: "P12", price: 10, modifierGroups: [] },
              ],
            },
          },
          {
            // untagged product → must stay unrestricted (shows everywhere)
            item: { id: "i3", name: "Shared dip", plu: "DIP", basePrice: 1 },
          },
        ],
      },
    ],
  };

  const data = transformMenuToCatalog(menu, groupById);
  const bySku = (ref: string) =>
    data.products.flatMap((p) => p.skus).find((s) => s.ref === ref)!;

  it("emits the catalog variants[] from the menu's pricing variants", () => {
    expect(data.variants).toEqual([
      { ref: "brandA__UBER_EATS", name: "Pizza Uno — Uber Eats" },
      { ref: "brandA__DELIVEROO", name: "Pizza Uno — Deliveroo" },
      { ref: "brandB__UBER_EATS", name: "Monster — Uber Eats" },
    ]);
  });

  it("restricts a brand-tagged product to its brand's variant refs", () => {
    expect(bySku("PIZZA1").restrictions).toEqual({
      variant_refs: ["brandA__UBER_EATS", "brandA__DELIVEROO"],
    });
  });

  it("leaves an untagged product unrestricted", () => {
    expect(bySku("DIP").restrictions).toBeUndefined();
  });

  it("sets price_overrides on a single-SKU item from platformPricingOverrides", () => {
    expect(bySku("PIZZA1").price).toBe("5.00 GBP");
    expect(bySku("PIZZA1").price_overrides).toEqual([
      { variant_refs: ["brandA__UBER_EATS"], price: "6.00 GBP" },
    ]);
  });

  it("sets per-size price_overrides only on the size that has one", () => {
    expect(bySku("P10").price).toBe("8.00 GBP");
    expect(bySku("P10").price_overrides).toEqual([
      { variant_refs: ["brandA__UBER_EATS"], price: "9.00 GBP" },
    ]);
    expect(bySku("P12").price_overrides).toBeUndefined();
  });

  it("sets price_overrides on a modifier option", () => {
    const opt = data.optionLists
      .find((g) => g.ref === "grp_g1")!
      .options.find((o) => o.ref === "opt_o1")!;
    expect(opt.price).toBe("1.00 GBP");
    expect(opt.price_overrides).toEqual([
      { variant_refs: ["brandA__UBER_EATS"], price: "1.50 GBP" },
    ]);
  });

  it("wires SKU option_list_refs to the emitted option_list", () => {
    expect(bySku("PIZZA1").option_list_refs).toEqual(["grp_g1"]);
    expect(bySku("P10").option_list_refs).toEqual(["grp_g1"]);
  });
});

describe("transformMenuToCatalog — multiple_selection vs max_selections", () => {
  const build = (selectionType: string, maxSelections: number | null) => {
    const g = {
      id: "g",
      name: "Group",
      selectionType,
      minSelections: 0,
      maxSelections,
      options: [{ id: "o", name: "Opt", priceAdjustment: 0, isDefault: false }],
    };
    const menu = { pricingVariants: [], categories: [] };
    return transformMenuToCatalog(menu, new Map([["g", g]])).optionLists[0]!;
  };

  it("ADDON with max>1 is multi-select", () => {
    const ol = build("ADDON", 3);
    expect(ol.multiple_selection).toBe(true);
    expect(ol.max_selections).toBe(3);
  });

  it("ADDON with no max is multi-select", () => {
    expect(build("ADDON", null).multiple_selection).toBe(true);
  });

  it("ADDON with max 1 is NOT multi-select (HubRise 422 guard)", () => {
    const ol = build("ADDON", 1);
    expect(ol.multiple_selection).toBe(false);
    expect(ol.max_selections).toBe(1);
  });

  it("ADDON with max 0 is NOT multi-select (HubRise 422 guard)", () => {
    expect(build("ADDON", 0).multiple_selection).toBe(false);
  });

  it("VARIANT (radio) is never multi-select", () => {
    expect(build("VARIANT", 5).multiple_selection).toBe(false);
  });
});
