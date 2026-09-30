import {
  buildKeetaMenuSync,
  keetaAllergens,
  keetaPriceString,
  type KeetaSrcMenu,
} from "../keeta-menu.transformer";

const menu = (over: Partial<KeetaSrcMenu> = {}): KeetaSrcMenu => ({
  shopId: "611469",
  currency: "AED",
  categories: [
    { code: "cat-1", name: "Burgers", itemCodes: ["item-1", "item-2"] },
    { code: "cat-2", name: "Drinks", itemCodes: ["item-3"] },
  ],
  items: [
    {
      code: "item-1",
      name: "Cheeseburger",
      secondLanguageName: "برجر بالجبن",
      description: "Beef, cheddar",
      imageUrl: "https://cdn.example.com/burger.jpg",
      available: true,
      pickup: true,
      delivery: true,
      allergens: ["Milk", "gluten", "unknown"],
      calories: 650,
      skus: [{ code: "item-1", spec: "", price: 32.5, groupCodes: ["grp-sauce"] }],
    },
    {
      code: "item-2",
      name: "Pizza",
      available: false,
      pickup: false,
      delivery: true,
      skus: [
        { code: "item-2__s0", spec: "10 inch", price: 40, groupCodes: ["grp-top"] },
        { code: "item-2__s1", spec: "12 inch", price: 50, groupCodes: ["grp-top__12"] },
      ],
    },
    {
      code: "item-3",
      name: "Coke",
      available: true,
      pickup: true,
      delivery: true,
      skus: [{ code: "item-3", spec: "", price: 8, groupCodes: [] }],
    },
  ],
  groups: [
    {
      code: "grp-sauce",
      name: "Sauce",
      minSelections: 1,
      maxSelections: 1,
      options: [
        { code: "opt-bbq", name: "BBQ", price: 0, available: true },
        { code: "opt-mayo", name: "Mayo", price: 1.5, available: true },
      ],
    },
    {
      code: "grp-top",
      name: "Toppings",
      minSelections: 0,
      maxSelections: null,
      allowDuplicateSelections: true,
      options: [{ code: "opt-olive", name: "Olives", price: 3, available: true }],
    },
    {
      code: "grp-top__12",
      name: "Toppings",
      minSelections: 0,
      maxSelections: null,
      options: [{ code: "opt-olive__12", name: "Olives", price: 4, available: true }],
    },
    { code: "grp-unused", name: "Unused", minSelections: 0, maxSelections: 1, options: [] },
  ],
  ...over,
});

describe("buildKeetaMenuSync", () => {
  it("builds a full-replace payload with our ids as openItemCodes", () => {
    const r = buildKeetaMenuSync(menu());
    expect(r.errors).toEqual([]);
    const p = r.payload as any;
    expect(p.shopCategoryList.map((c: any) => c.openItemCode)).toEqual(["cat-1", "cat-2"]);
    expect(p.spuList.map((s: any) => s.openItemCode)).toEqual(["item-1", "item-2", "item-3"]);
    // Only groups something uses — an unused, optionless group isn't sent.
    expect(p.choiceGroupList.map((g: any) => g.openItemCode).sort()).toEqual(["grp-sauce", "grp-top", "grp-top__12"]);
  });

  it("never marks a category as mandatory (type 1 forces customers to buy from it)", () => {
    const p = buildKeetaMenuSync(menu()).payload as any;
    expect(p.shopCategoryList.every((c: any) => c.type === 0)).toBe(true);
  });

  it("sends prices as major-unit strings with the currency's decimals", () => {
    const p = buildKeetaMenuSync(menu()).payload as any;
    expect(p.spuList[0].skuList[0]).toMatchObject({ price: "32.50", pickPrice: "32.50", currency: "AED" });
    expect(p.choiceGroupList.find((g: any) => g.openItemCode === "grp-sauce").choiceGroupSkuList[1].price).toBe("1.50");
  });

  it("models sizes as SKUs of one SPU, each with its own groups", () => {
    const pizza = (buildKeetaMenuSync(menu()).payload as any).spuList[1];
    expect(pizza.skuList.map((s: any) => [s.spec, s.price, s.choiceGroupOpenItemCodeList])).toEqual([
      ["10 inch", "40.00", ["grp-top"]],
      ["12 inch", "50.00", ["grp-top__12"]],
    ]);
  });

  it("publishes an 86'd item as unavailable rather than dropping it", () => {
    expect((buildKeetaMenuSync(menu()).payload as any).spuList[1].status).toBe(0);
  });

  it("sends an Arabic second name as the translation", () => {
    const burger = (buildKeetaMenuSync(menu()).payload as any).spuList[0];
    expect(burger).toMatchObject({
      name: "Cheeseburger",
      sourceLanguageType: "en",
      nameTranslation: "برجر بالجبن",
      targetLanguageType: "ar",
      nameTranslateType: 1,
    });
  });

  it("does NOT send a kitchen-language (non-Arabic) second name to customers", () => {
    const m = menu();
    m.items[0]!.secondLanguageName = "芝士汉堡";
    const burger = (buildKeetaMenuSync(m).payload as any).spuList[0];
    expect(burger.nameTranslation).toBeUndefined();
  });

  it("offers pickup only where the item is sold for collection", () => {
    const p = buildKeetaMenuSync(menu()).payload as any;
    expect(p.spuList[0].userGetModeList).toEqual(["delivery", "pickup"]);
    expect(p.spuList[1].userGetModeList).toEqual(["delivery"]);
  });

  it("turns an unlimited max into a number Keeta accept, and keeps repeatable groups open", () => {
    const top = (buildKeetaMenuSync(menu()).payload as any).choiceGroupList.find((g: any) => g.openItemCode === "grp-top");
    expect(top).toMatchObject({ minNumber: 0, maxNumber: 1, repeatable: 1 });
  });

  it("orders products within each category, covering every product in every category", () => {
    expect((buildKeetaMenuSync(menu()).payload as any).spuSequenceCodeMap).toEqual({
      "cat-1": ["item-1", "item-2"],
      "cat-2": ["item-3"],
    });
  });

  it("maps allergens onto Keeta's vocabulary and drops unknown ones", () => {
    expect(keetaAllergens(["Milk", "gluten", "unknown", "sesame"])).toEqual(["Milk", "Grains", "Sesame seeds"]);
    const sku = (buildKeetaMenuSync(menu()).payload as any).spuList[0].skuList[0];
    expect(sku.allergens).toEqual(["Milk", "Grains"]);
    expect(sku.nutritionalInfo).toEqual({ calories_kcal: 650 });
  });

  it("refuses a group that can never be satisfied", () => {
    const m = menu();
    m.groups[0]!.minSelections = 3;
    const r = buildKeetaMenuSync(m);
    expect(r.payload).toBeNull();
    expect(r.errors[0]).toMatchObject({ entity: "group", code: "grp-sauce" });
  });

  it("refuses duplicate category names", () => {
    const m = menu();
    m.categories[1]!.name = "burgers";
    expect(buildKeetaMenuSync(m).errors.some((e) => e.entity === "category")).toBe(true);
  });

  it("refuses an option with nested choices that shares a product's name", () => {
    const m = menu();
    m.groups[0]!.options[0] = { code: "opt-coke", name: "Coke", price: 0, available: true, groupCodes: ["grp-top"] };
    const r = buildKeetaMenuSync(m);
    expect(r.errors.some((e) => e.entity === "option" && e.code === "opt-coke")).toBe(true);
  });

  it("warns (but publishes) when a plain option shares a product's name — Keeta link their stock", () => {
    const m = menu();
    m.groups[0]!.options[0] = { code: "opt-coke", name: "Coke", price: 0, available: true };
    const r = buildKeetaMenuSync(m);
    expect(r.payload).not.toBeNull();
    expect(r.warnings.some((w) => w.code === "opt-coke")).toBe(true);
  });

  it("refuses a 3-decimal option price Keeta's 2-decimal field can't hold", () => {
    const m = menu({ currency: "KWD" });
    m.groups[0]!.options[1]!.price = 0.125;
    expect(buildKeetaMenuSync(m).errors.some((e) => e.entity === "option")).toBe(true);
  });

  it("drops empty categories and refuses a menu with nothing to sell", () => {
    const r = buildKeetaMenuSync(menu({ items: [] }));
    expect(r.payload).toBeNull();
    expect(r.errors[0]!.message).toMatch(/Nothing to publish/);
  });
});

describe("keetaPriceString", () => {
  it("formats by the currency's decimals, capped by the field", () => {
    expect(keetaPriceString(1.25, "KWD", 3)).toBe("1.250");
    expect(keetaPriceString(1.25, "KWD", 2)).toBe("1.25");
    expect(keetaPriceString(1.255, "KWD", 2)).toBeNull();
    expect(keetaPriceString(12, "AED", 3)).toBe("12.00");
    expect(keetaPriceString(-1, "AED", 2)).toBeNull();
  });
});
