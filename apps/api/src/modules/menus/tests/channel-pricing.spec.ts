import { MenusService } from "../menus.service";
import { brandChannelRef } from "@orderhub/shared";

// ── Channel pricing ─────────────────────────────────────────────────────────
//
// A marketplace takes commission, so the same dish has to list higher there
// than on the operator's own site. Before this, that was a per-product modal —
// unusable across 600 products — and a menu imported FROM a marketplace
// arrived with the uplift already baked into basePrice, invisible and
// impossible to take back out. De Salt's whole menu was 20% high on its own
// POS and website for exactly that reason.
//
// The rule these pin: the uplift is stored as a per-channel OVERRIDE and the
// base price is never touched. That's what keeps the markup visible,
// adjustable, and reversible.

const BRAND = "brand-1";
const UBER = brandChannelRef(BRAND, "UBER_EATS");
const DELIVEROO = brandChannelRef(BRAND, "DELIVEROO");

function makeService(items: any[], options: any[] = [], groupIds: string[] = []) {
  const updatedItems: any[] = [];
  const updatedOptions: any[] = [];
  let savedVariants: any = null;
  const prisma = {
    menu: {
      findFirst: jest.fn().mockResolvedValue({ id: "m1", pricingVariants: [] }),
      update: jest.fn(async ({ data }: any) => {
        savedVariants = data.pricingVariants;
        return {};
      }),
    },
    brand: {
      findFirst: jest.fn().mockResolvedValue({ id: BRAND, name: "Pizza Uno" }),
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).map((id) => ({
          id,
          name: id === BRAND ? "Pizza Uno" : id,
        })),
      ),
    },
    menuCategory: {
      findMany: jest.fn().mockResolvedValue([
        {
          items: items.map((item) => ({
            item: { modifierGroupLinks: groupIds.map((g) => ({ groupId: g })), ...item },
          })),
        },
      ]),
    },
    menuItem: {
      update: jest.fn(async (args: any) => {
        updatedItems.push(args);
        return {};
      }),
    },
    modifierGroup: { findMany: jest.fn().mockResolvedValue([]) },
    modifierOption: {
      findMany: jest.fn().mockResolvedValue(options),
      update: jest.fn(async (args: any) => {
        updatedOptions.push(args);
        return {};
      }),
    },
  } as any;
  const svc = new MenusService(prisma, {} as any, {} as any, {} as any);
  return { svc, updatedItems, updatedOptions, variants: () => savedVariants };
}

const flatItem = (id: string, price: number, overrides: any = {}) => ({
  id,
  basePrice: price,
  productSkus: [],
  platformPricingOverrides: overrides,
});

describe("channel pricing — the uplift", () => {
  it("writes an override and leaves the base price alone", async () => {
    // The whole point: base stays true so POS and the operator's own site
    // keep charging the real price.
    const { svc, updatedItems } = makeService([flatItem("i1", 10)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", name: "Uber Eats", percent: 20 }],
    });
    const data = updatedItems[0].data;
    expect(data.platformPricingOverrides[UBER]).toBe(12);
    expect(data.basePrice).toBeUndefined();
  });

  it("rounds to the penny", async () => {
    // 7.99 + 20% = 9.588. Prices are money, not floats.
    const { svc, updatedItems } = makeService([flatItem("i1", 7.99)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    expect(updatedItems[0].data.platformPricingOverrides[UBER]).toBe(9.59);
  });

  it("applies a different percentage per channel in one pass", async () => {
    const { svc, updatedItems } = makeService([flatItem("i1", 10)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [
        { channelKey: "UBER_EATS", percent: 20 },
        { channelKey: "DELIVEROO", percent: 15 },
      ],
    });
    const o = updatedItems[0].data.platformPricingOverrides;
    expect(o[UBER]).toBe(12);
    expect(o[DELIVEROO]).toBe(11.5);
  });

  it("0% CLEARS the override rather than writing the base price", async () => {
    // Writing base would freeze this channel at today's number: change the
    // base later and the channel would silently keep the old one. Blank means
    // "follow the base", which is what the per-product modal already means.
    const { svc, updatedItems } = makeService([
      flatItem("i1", 10, { [UBER]: 12 }),
    ]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 0 }],
    });
    expect(updatedItems[0].data.platformPricingOverrides).not.toHaveProperty(UBER);
  });

  it("leaves another channel's existing override untouched", async () => {
    const { svc, updatedItems } = makeService([
      flatItem("i1", 10, { [DELIVEROO]: 11.5 }),
    ]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    const o = updatedItems[0].data.platformPricingOverrides;
    expect(o[DELIVEROO]).toBe(11.5);
    expect(o[UBER]).toBe(12);
  });
});

describe("channel pricing — sizes and modifiers", () => {
  it("uplifts every size from its OWN price, not the item's base", async () => {
    // A 14" pizza costs more than a 10", so one uplift off the base would
    // undercharge the big one and overcharge the small one.
    const { svc, updatedItems } = makeService([
      {
        id: "i1",
        basePrice: 8,
        platformPricingOverrides: {},
        productSkus: [
          { name: '10"', price: 8, priceOverrides: {} },
          { name: '14"', price: 13, priceOverrides: {} },
        ],
      },
    ]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    const skus = updatedItems[0].data.productSkus;
    expect(skus[0].priceOverrides[UBER]).toBe(9.6);
    expect(skus[1].priceOverrides[UBER]).toBe(15.6);
  });

  it("uplifts modifier options too", async () => {
    // A meal upgrade the uplift missed is commission paid out of margin on
    // every order that includes one.
    const { svc, updatedOptions } = makeService(
      [flatItem("i1", 10)],
      [{ id: "o1", priceAdjustment: 2.5, platformPricingOverrides: {} }],
      ["g1"],
    );
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    expect(updatedOptions[0].data.platformPricingOverrides[UBER]).toBe(3);
  });

  it("finds groups attached to a SIZE, not just to the item", async () => {
    // Sized products route their groups through the SKU as bare ids with no
    // FK. Reading only the item's links would leave every pizza's crust list
    // at its old price.
    const { svc, updatedOptions } = makeService(
      [
        {
          id: "i1",
          basePrice: 8,
          platformPricingOverrides: {},
          productSkus: [{ name: '10"', price: 8, priceOverrides: {}, modifierGroups: ["g-crust"] }],
        },
      ],
      [{ id: "o1", priceAdjustment: 2, platformPricingOverrides: {} }],
    );
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 25 }],
    });
    expect(updatedOptions).toHaveLength(1);
    expect(updatedOptions[0].data.platformPricingOverrides[UBER]).toBe(2.5);
  });
});

describe("channel pricing — variants", () => {
  it("registers each channel as a brand variant the rest of the system knows", async () => {
    // Same refs the per-product modal and the publishers already use, so this
    // is a bulk way to set existing data — not a parallel concept.
    const { svc, variants } = makeService([flatItem("i1", 10)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", name: "Uber Eats", percent: 20 }],
    });
    expect(variants()).toEqual([
      {
        ref: UBER,
        name: "Pizza Uno — Uber Eats",
        channelKey: "UBER_EATS",
        brandId: BRAND,
      },
    ]);
  });
});

// ── Which brand the override is keyed to ────────────────────────────────────
//
// The bug this pins, found in production: the uplift was keyed to the MENU's
// brand. A menu can carry products belonging to a different brand — Grill
// Stop — Pelton is a "pizza yoyo-test" menu holding "monster burgerzz-pelton"
// products — and publishers resolve a variant against the PRODUCT's brand.
// So 944 overrides were written under a ref nothing would ever look up: the
// call reported success, and not one price would have changed on any channel.

describe("channel pricing — brand resolution", () => {
  const OTHER = "brand-other";
  const OTHER_UBER = brandChannelRef(OTHER, "UBER_EATS");

  it("keys the override to the PRODUCT's brand, not the menu's", async () => {
    const { svc, updatedItems } = makeService([
      { ...flatItem("i1", 10), brandId: OTHER },
    ]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND, // the menu's brand — deliberately not the product's
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    const o = updatedItems[0].data.platformPricingOverrides;
    expect(o[OTHER_UBER]).toBe(12);
    expect(o).not.toHaveProperty(UBER);
  });

  it("covers a product sold under several brands", async () => {
    const { svc, updatedItems } = makeService([
      { ...flatItem("i1", 10), brandId: OTHER, brandIds: [OTHER, BRAND] },
    ]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    const o = updatedItems[0].data.platformPricingOverrides;
    expect(o[OTHER_UBER]).toBe(12);
    expect(o[UBER]).toBe(12);
  });

  it("falls back to the menu's brand when the product names none", async () => {
    // Skipping would leave that product silently un-uplifted.
    const { svc, updatedItems } = makeService([flatItem("i1", 10)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", percent: 20 }],
    });
    expect(updatedItems[0].data.platformPricingOverrides[UBER]).toBe(12);
  });

  it("registers a variant for every brand it actually touched", async () => {
    // Without the variant, the ref exists on the product and the publisher
    // still has nothing to match it against.
    const { svc, variants } = makeService([
      { ...flatItem("i1", 10), brandId: OTHER },
    ]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "UBER_EATS", name: "Uber Eats", percent: 20 }],
    });
    const refs = (variants() ?? []).map((v: any) => v.ref);
    expect(refs).toContain(OTHER_UBER);
  });
});

// ── Custom channels ─────────────────────────────────────────────────────────
//
// The presets won't be the whole list forever — Careem, Talabat, whatever
// launches next. A typed name becomes a slugified key, the same one the
// per-product modal produces, so a channel added in either place is the same
// channel rather than two that look alike.

describe("channel pricing — custom channels", () => {
  it("accepts a channel that isn't a preset", async () => {
    const { svc, updatedItems, variants } = makeService([flatItem("i1", 10)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [{ channelKey: "CAREEM", name: "Careem", percent: 15 }],
    });
    const ref = brandChannelRef(BRAND, "CAREEM");
    expect(updatedItems[0].data.platformPricingOverrides[ref]).toBe(11.5);
    expect(variants()).toEqual([
      {
        ref,
        name: "Pizza Uno — Careem",
        channelKey: "CAREEM",
        brandId: BRAND,
      },
    ]);
  });

  it("keeps presets and custom channels apart in one pass", async () => {
    const { svc, updatedItems } = makeService([flatItem("i1", 10)]);
    await svc.applyChannelPricing("m1", "t1", {
      brandId: BRAND,
      channels: [
        { channelKey: "UBER_EATS", name: "Uber Eats", percent: 20 },
        { channelKey: "TALABAT", name: "Talabat", percent: 30 },
      ],
    });
    const o = updatedItems[0].data.platformPricingOverrides;
    expect(o[UBER]).toBe(12);
    expect(o[brandChannelRef(BRAND, "TALABAT")]).toBe(13);
  });
});
