import { VariantPriceResolverService } from "../variant-price-resolver.service";

// FOOD PUBLISHED AT £0.
//
// Just Eat order 977004437 (Kingston Pizza, 23 Oct 2026) arrived with four
// pizzas at £0.00 — the size came through as a £2.10 modifier and the base was
// nothing. The subtotal Just Eat charged matched that, so the customer really
// did get four pizzas for the price of three toppings.
//
// The cause is a stale ZERO in the channel price override, and it is written by
// our own "Apply to menu" uplift:
//
//   const base = Number(item.basePrice) || 0;
//   overrides[ref] = uplift(base, ch.percent);   // uplift(0, 20) === 0
//
// Run the uplift while an item is still unpriced — which is every imported
// menu before someone fills the prices in — and a hard 0 is frozen into that
// channel. Setting the real base price afterwards does NOT dislodge it, because
// an override always wins. At publish time:
//
//   variantMap?.itemPrice(it) ?? Number(it.basePrice)
//
// `0 ?? 8.45` is 0. The nullish coalesce cannot save us: the override is
// present and it is zero.
//
// Real data from the menu, Tandoori Chicken Pizza, basePrice 8.45:
//   JUST_EAT:   8.87   ← uplift applied after the price was set
//   DELIVEROO:  0      ← frozen from when the base was still 0
//   UBER_EATS:  0
//
// A zero override on an item that HAS a price is unpriced, not free. A
// genuinely free item has a base price of 0 and keeps it.

function resolverFor(menu: any) {
  const prisma = { menu: { findUnique: jest.fn(async () => menu) } } as any;
  return new VariantPriceResolverService(prisma);
}

const REF = "brand1__JUST_EAT";

function menuWith(item: any) {
  return {
    pricingVariants: [{ ref: REF, channelKey: "JUST_EAT", brandId: null }],
    categories: [{ items: [{ item }] }],
  };
}

describe("A zero channel-price override never reaches the platform", () => {
  it("ignores a 0 override on an item that has a real base price", async () => {
    const map = await resolverFor(
      menuWith({
        id: "i1",
        name: "Tandoori Chicken Pizza",
        externalId: "PROD-9HTJQN",
        basePrice: "8.45",
        hasMultipleSkus: false,
        productSkus: [],
        platformPricingOverrides: { [REF]: 0 },
        modifierGroupLinks: [],
      }),
    ).buildPriceMap("m1", REF);

    // undefined, so the publisher falls back to the item's own £8.45.
    expect(map.itemPrice({ externalId: "PROD-9HTJQN", name: "Tandoori Chicken Pizza" }))
      .toBeUndefined();
  });

  it("keeps a genuinely free item free", async () => {
    // basePrice 0 and override 0 agree — nothing to protect against.
    const map = await resolverFor(
      menuWith({
        id: "i2",
        name: "Free Dip",
        externalId: "PROD-FREE",
        basePrice: "0",
        hasMultipleSkus: false,
        productSkus: [],
        platformPricingOverrides: { [REF]: 0 },
        modifierGroupLinks: [],
      }),
    ).buildPriceMap("m1", REF);

    expect(map.itemPrice({ externalId: "PROD-FREE", name: "Free Dip" })).toBe(0);
  });

  it("leaves a real override alone", async () => {
    const map = await resolverFor(
      menuWith({
        id: "i3",
        name: "Chips",
        externalId: "PROD-X4FR2W",
        basePrice: "3",
        hasMultipleSkus: false,
        productSkus: [],
        platformPricingOverrides: { [REF]: 3.15 },
        modifierGroupLinks: [],
      }),
    ).buildPriceMap("m1", REF);

    expect(map.itemPrice({ externalId: "PROD-X4FR2W", name: "Chips" })).toBe(3.15);
  });

  it("ignores a 0 override on a priced SIZE", async () => {
    // The same freeze happens per size: uplift(sku.price || 0, pct).
    const map = await resolverFor(
      menuWith({
        id: "i4",
        name: "Margherita",
        externalId: "PROD-MARG",
        basePrice: "7",
        hasMultipleSkus: true,
        productSkus: [
          { name: "10inch", plu: "PROD-MARG-1", price: 9.5, priceOverrides: { [REF]: 0 } },
          { name: "12inch", plu: "PROD-MARG-2", price: 12, priceOverrides: { [REF]: 13.2 } },
        ],
        platformPricingOverrides: {},
        modifierGroupLinks: [],
      }),
    ).buildPriceMap("m1", REF);

    const item = { externalId: "PROD-MARG", name: "Margherita" };
    expect(map.skuPrice(item, { plu: "PROD-MARG-1", name: "10inch" })).toBeUndefined();
    expect(map.skuPrice(item, { plu: "PROD-MARG-2", name: "12inch" })).toBe(13.2);
  });

  it("ignores a 0 override on an option that normally costs money", async () => {
    const map = await resolverFor(
      menuWith({
        id: "i5",
        name: "Kebab",
        externalId: "PROD-KEB",
        basePrice: "9.5",
        hasMultipleSkus: false,
        productSkus: [],
        platformPricingOverrides: {},
        modifierGroupLinks: [
          {
            group: {
              options: [
                { name: "Cheesy chips", externalId: "OPT-CC", priceAdjustment: 2.5,
                  platformPricingOverrides: { [REF]: 0 } },
                { name: "Garlic Mayo", externalId: "OPT-GM", priceAdjustment: 0,
                  platformPricingOverrides: { [REF]: 0 } },
              ],
            },
          },
        ],
      }),
    ).buildPriceMap("m1", REF);

    // A paid extra must not become free…
    expect(map.optionPrice({ externalId: "OPT-CC", name: "Cheesy chips" })).toBeUndefined();
    // …while a free one stays free.
    expect(map.optionPrice({ externalId: "OPT-GM", name: "Garlic Mayo" })).toBe(0);
  });
});
