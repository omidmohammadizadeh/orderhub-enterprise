import {
  transformCareemMenu,
  validateCareemGroup,
  careemPrice,
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

describe("validateCareemGroup — Careem's own rules", () => {
  it("accepts a normal pick-one group", () => {
    expect(validateCareemGroup(group())).toEqual([]);
  });

  it("rejects a pick-one group whose max exceeds its option count", () => {
    expect(validateCareemGroup(group({ maxSelections: 5 }))).toEqual([
      expect.stringContaining("max must be between min and 2"),
    ]);
  });

  it("requires min > 1 on a multi-select group", () => {
    // Their rule, verbatim: when multi_select is true, min must be > 1.
    const problems = validateCareemGroup(
      group({ selectionType: "ADDON", minSelections: 1, maxSelections: 1 }),
    );
    expect(problems).toEqual([expect.stringContaining("min > 1")]);
  });

  it("requires max to EQUAL min on a multi-select group", () => {
    const problems = validateCareemGroup(
      group({ selectionType: "ADDON", minSelections: 2, maxSelections: 2 }),
    );
    expect(problems).toEqual([]);
    expect(
      validateCareemGroup(
        group({ selectionType: "ADDON", minSelections: 2, maxSelections: 3 }),
      ),
    ).toEqual([expect.stringContaining("max = min")]);
  });

  it("forbids nested groups inside a multi-select group", () => {
    const problems = validateCareemGroup(
      group({
        selectionType: "ADDON",
        minSelections: 2,
        maxSelections: 2,
        options: [
          { id: "o1", name: "Fries", priceAdjustment: 0, isAvailable: true, sortOrder: 1, groupIds: ["g2"] },
          { id: "o2", name: "Slaw", priceAdjustment: 0, isAvailable: true, sortOrder: 2 },
        ],
      }),
    );
    expect(problems).toEqual([expect.stringContaining("cannot contain nested groups")]);
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
