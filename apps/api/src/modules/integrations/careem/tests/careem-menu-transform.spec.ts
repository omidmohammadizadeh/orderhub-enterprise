import {
  transformCareemMenu,
  validateCareemGroup,
  careemPrice,
  careemGroupSelection,
  CAREEM_MAX_ITEMS,
  type SourceGroup,
  type SourceMenu,
} from "../careem-menu.transformer";

const group = (over: Partial<SourceGroup> = {}): SourceGroup => ({
  id: "g1",
  name: "Choose a sauce",
  minSelections: 0,
  maxSelections: 1,
  isRequired: false,
  sortOrder: 1,
  selectionType: "VARIANT",
  options: [
    { id: "o1", name: "BBQ", priceAdjustment: 0, isAvailable: true, sortOrder: 1 },
    { id: "o2", name: "Garlic", priceAdjustment: 1, isAvailable: true, sortOrder: 2 },
  ],
  ...over,
});

const menu = (over: Partial<SourceMenu> = {}): SourceMenu => ({
  id: "menu-1",
  name: "Main menu",
  country: "AE",
  currency: "AED",
  taxPercentage: 5,
  categories: [
    { id: "cat-1", name: "Burgers", sortOrder: 1, itemIds: ["item-1"] },
  ],
  items: [
    {
      id: "item-1",
      name: "Beef Burger",
      secondLanguageName: "برجر لحم",
      basePrice: 25,
      isAvailable: true,
      sortOrder: 1,
      groupIds: ["g1"],
    },
  ],
  groups: [group()],
  ...over,
});

const build = (m: SourceMenu, unit: "major" | "minor" = "major") =>
  transformCareemMenu(m, { unit, branchId: "loc-1" });

describe("careemPrice", () => {
  it("sends fils when the unit is minor", () => {
    expect(careemPrice(11.5, "minor")).toBe(1150);
    expect(careemPrice(25, "minor")).toBe(2500);
  });

  it("refuses a fractional price in whole units rather than rounding it", () => {
    // Their schema says `integer` and never states the unit. Rounding 11.50 to
    // 12 (or to 11) is how every price on a menu ends up wrong by an amount
    // nobody notices until a customer complains.
    expect(careemPrice(11.5, "major")).toBeNull();
    expect(careemPrice(25, "major")).toBe(25);
  });

  it("survives floating-point representation", () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754.
    expect(careemPrice(19.99, "minor")).toBe(1999);
  });
});

describe("careemGroupSelection — choosing the mode Careem will accept", () => {
  // Careem's two modes are not our two modes, and mapping ADDON -> multi_select
  // is what filled a real menu with rejections. Their rules read as
  // constraints, not semantics:
  //
  //   multi_select false — any range: 0 <= min <= count, min <= max <= count
  //   multi_select true  — exactly N, N > 1: min > 1 and max === min, never
  //                        with nested groups
  //
  // So the mode follows the numbers. These tests assert the output is legal
  // under whichever mode it picked, because that is the only thing Careem
  // check.
  const legal = (g: SourceGroup) => {
    const { multi_select, min, max } = careemGroupSelection(g);
    const count = g.options.length;
    if (multi_select) {
      expect(min).toBeGreaterThan(1);
      expect(max).toBe(min);
      expect(g.options.some((o) => (o.groupIds ?? []).length > 0)).toBe(false);
    } else {
      expect(min).toBeGreaterThanOrEqual(0);
      expect(min).toBeLessThanOrEqual(count);
      expect(max).toBeGreaterThanOrEqual(min);
      expect(max).toBeLessThanOrEqual(count);
    }
    return { multi_select, min, max };
  };

  it('sends "choose any of these toppings" as a range, not multi-select', () => {
    // The real case from TEST 22: min 0, max 7. Only expressible with
    // multi_select false, and it was going out as true.
    const g = group({
      selectionType: "ADDON",
      minSelections: 0,
      maxSelections: 2,
    });
    expect(legal(g)).toEqual({ multi_select: false, min: 0, max: 2 });
  });

  it("sends a pick-one group as a range too", () => {
    const g = group({ selectionType: "VARIANT", minSelections: 1, maxSelections: 1 });
    expect(legal(g)).toEqual({ multi_select: false, min: 1, max: 1 });
  });

  it('uses their multi-select only for "exactly N", N > 1', () => {
    const g = group({ selectionType: "ADDON", minSelections: 2, maxSelections: 2 });
    expect(legal(g)).toEqual({ multi_select: true, min: 2, max: 2 });
  });

  it("never multi-selects a group holding nested groups", () => {
    // Their rule: a group with nested groups may not set multi_select true.
    // The numbers here would otherwise qualify.
    const g = group({
      selectionType: "ADDON",
      minSelections: 2,
      maxSelections: 2,
      options: [
        { id: "o1", name: "Fries", priceAdjustment: 0, isAvailable: true, sortOrder: 1, groupIds: ["g2"] },
        { id: "o2", name: "Slaw", priceAdjustment: 0, isAvailable: true, sortOrder: 2 },
      ],
    });
    expect(legal(g).multi_select).toBe(false);
  });

  it("clamps a max above the option count", () => {
    // The fixture has two options; a max of 5 is not expressible.
    expect(legal(group({ maxSelections: 5 }))).toEqual({
      multi_select: false,
      min: 0,
      max: 2,
    });
  });

  it("defaults a missing max to the option count", () => {
    expect(legal(group({ minSelections: 0, maxSelections: null }))).toEqual({
      multi_select: false,
      min: 0,
      max: 2,
    });
  });
});

describe("validateCareemGroup — what choosing a mode cannot fix", () => {
  it("accepts a normal pick-one group", () => {
    expect(validateCareemGroup(group())).toEqual([]);
  });

  it("accepts the pick-any group that used to be rejected", () => {
    expect(
      validateCareemGroup(
        group({ selectionType: "ADDON", minSelections: 0, maxSelections: 2 }),
      ),
    ).toEqual([]);
  });

  it("refuses to ask for more selections than there are options", () => {
    // Three of two cannot be honoured, and clamping it to two silently changes
    // what the kitchen is told to make.
    expect(
      validateCareemGroup(group({ minSelections: 3, maxSelections: 3 })),
    ).toEqual([expect.stringContaining("requires 3 selections but only has 2")]);
  });

  it("refuses a max below its min", () => {
    expect(
      validateCareemGroup(group({ minSelections: 2, maxSelections: 1 })),
    ).toEqual([expect.stringContaining("below min")]);
  });

  it("catches a blank name and an empty group", () => {
    expect(validateCareemGroup(group({ name: "  ", options: [] }))).toEqual([
      "name cannot be blank",
      "has no options",
    ]);
  });
});

describe("transformCareemMenu", () => {
  it("emits five flat arrays cross-referenced by id", () => {
    // Careem's catalog is not a nested document — the references are id lists.
    const { payload, errors } = build(menu());
    expect(errors).toEqual([]);
    expect(payload!.categories).toHaveLength(1);
    expect(payload!.items).toHaveLength(1);
    expect(payload!.groups).toHaveLength(1);
    expect(payload!.options).toHaveLength(2);
    expect((payload!.categories[0] as { items: string[] }).items).toEqual(["item-1"]);
    expect((payload!.items[0] as { groups: string[] }).groups).toEqual(["g1"]);
    expect((payload!.groups[0] as { options: string[] }).options).toEqual(["o1", "o2"]);
  });

  it("publishes OUR ids, which is what makes inbound orders resolvable", () => {
    // An order carries ids and no names. These are the ids it will carry.
    const { payload } = build(menu());
    expect((payload!.items[0] as { id: string }).id).toBe("item-1");
    expect((payload!.options[0] as { id: string }).id).toBe("o1");
  });

  it("sends the Arabic name where we have one", () => {
    const { payload } = build(menu());
    expect((payload!.items[0] as { name_localized: unknown }).name_localized).toEqual({
      en: "Beef Burger",
      ar: "برجر لحم",
    });
  });

  it("declares prices tax-inclusive at the menu's rate", () => {
    // Careem's catalog prices INCLUDE tax — this is the rate baked in, not one
    // to add on top. UAE 5%.
    const { payload } = build(menu());
    expect(payload!.catalog.include_tax).toBe(true);
    expect(payload!.catalog.tax).toBe(5);
  });

  it("does a full replace, so our menu is the truth", () => {
    expect(build(menu()).payload!.diff).toBe(false);
  });

  it("keeps nested groups, which Careem supports natively", () => {
    // Our HubRise publish flattens these away. Careem takes them as they are.
    const nested = group({ id: "g2", name: "Sauce for the fries" });
    const { payload, errors } = build(
      menu({
        groups: [
          group({
            options: [
              { id: "o1", name: "Fries", priceAdjustment: 0, isAvailable: true, sortOrder: 1, groupIds: ["g2"] },
            ],
            maxSelections: 1,
          }),
          nested,
        ],
      }),
    );
    expect(errors).toEqual([]);
    expect((payload!.options[0] as { groups?: string[] }).groups).toEqual(["g2"]);
  });

  it("refuses a nested group that isn't in the payload", () => {
    // The option would reference nothing and Careem would take it anyway.
    const { payload, errors } = build(
      menu({
        groups: [
          group({
            maxSelections: 1,
            options: [
              { id: "o1", name: "Fries", priceAdjustment: 0, isAvailable: true, sortOrder: 1, groupIds: ["ghost"] },
            ],
          }),
        ],
      }),
    );
    expect(payload).toBeNull();
    expect(errors[0]!.message).toContain("nested group ghost");
  });

  it("refuses to publish rather than round a price it cannot express", () => {
    const { payload, errors } = build(
      menu({ items: [{ ...menu().items[0]!, basePrice: 11.5 }] }),
      "major",
    );
    expect(payload).toBeNull();
    expect(errors[0]).toMatchObject({ entity: "item", id: "item-1" });
    expect(errors[0]!.message).toContain("CAREEM_PRICE_UNIT");
  });

  it("publishes that same price happily in minor units", () => {
    const { payload, errors } = build(
      menu({ items: [{ ...menu().items[0]!, basePrice: 11.5 }] }),
      "minor",
    );
    expect(errors).toEqual([]);
    expect((payload!.items[0] as { price: number }).price).toBe(1150);
  });

  it("catches blank names before Careem does", () => {
    // Their FAQ documents the exact error: "Name cannot be blank!" — three
    // times over, with no indication of which entity. Better to say which.
    const { payload, errors } = build(
      menu({ items: [{ ...menu().items[0]!, name: "   " }] }),
    );
    expect(payload).toBeNull();
    expect(errors).toContainEqual(
      expect.objectContaining({ entity: "item", id: "item-1" }),
    );
  });

  it("drops a category's reference to an item that isn't in the menu", () => {
    const { payload, errors } = build(
      menu({
        categories: [{ id: "cat-1", name: "Burgers", sortOrder: 1, itemIds: ["item-1", "gone"] }],
      }),
    );
    expect(payload).toBeNull();
    expect(errors[0]!.message).toContain("1 item(s) not in this menu");
  });

  it("refuses a menu over Careem's item ceiling", () => {
    const many = Array.from({ length: CAREEM_MAX_ITEMS + 1 }, (_, i) => ({
      ...menu().items[0]!,
      id: `i${i}`,
    }));
    const { payload, errors } = build(
      menu({ items: many, categories: [{ id: "c", name: "All", sortOrder: 1, itemIds: [] }] }),
    );
    expect(payload).toBeNull();
    expect(errors[0]!.message).toContain(String(CAREEM_MAX_ITEMS));
  });

  it("names the branch as the catalog id", () => {
    // One catalog per branch — so "which catalog?" has an obvious answer in a
    // support conversation.
    expect(build(menu()).payload!.catalog.id).toBe("loc-1");
  });
});

// Careem identify a currency by an integer of their own, and the field is
// required — we shipped without it, which would have had every catalog
// rejected outright.
describe("transformCareemMenu — currency and country", () => {
  it("sends Careem's own currency integer, not the ISO code", () => {
    const { payload } = build(menu());
    expect(payload!.catalog.currency_id).toBe(1); // AED
  });

  it("maps a Saudi menu to their Riyal id", () => {
    const { payload } = build(menu({ country: "SA", currency: "SAR" }));
    expect(payload!.catalog.currency_id).toBe(2);
  });

  it("refuses a country Careem does not serve", () => {
    // Their API covers UAE, Jordan and KSA. A British shop has no outlet to
    // map to, so this fails here rather than five minutes after upload.
    const { payload, errors } = build(menu({ country: "GB", currency: "GBP" }));
    expect(payload).toBeNull();
    expect(errors.some((e) => /UAE, Jordan and KSA/.test(e.message))).toBe(true);
  });

  it("refuses a currency Careem has no id for", () => {
    const { payload, errors } = build(menu({ country: "AE", currency: "GBP" }));
    expect(payload).toBeNull();
    expect(errors.some((e) => /no currency id/.test(e.message))).toBe(true);
  });

  it("serves Jordan, the third country they cover", () => {
    const { payload } = build(menu({ country: "JO", currency: "JOD" }));
    expect(payload!.catalog.currency_id).toBe(7);
  });
});
