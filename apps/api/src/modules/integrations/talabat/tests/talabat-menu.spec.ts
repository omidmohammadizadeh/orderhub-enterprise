import { ADDONS_CATEGORY_ID, buildTalabatCatalog, talabatOptionAliases, tbSchedule, type TbSrcGroup, type TbSrcMenu } from "../talabat-menu.transformer";
import { TalabatSandboxService } from "../talabat-sandbox.service";

const group = (g: Partial<TbSrcGroup> & { id: string }): TbSrcGroup => ({
  name: g.id,
  min: 0,
  max: null,
  options: [],
  ...g,
});

function menu(over: Partial<TbSrcMenu> = {}): TbSrcMenu {
  return {
    menuId: "m1",
    menuName: "Main",
    categories: [{ id: "c1", name: "Burgers", itemIds: ["burger"] }],
    items: [
      {
        id: "burger",
        name: "Burger",
        secondLanguageName: "برجر",
        description: "Beef",
        imageUrl: "https://cdn.example.com/burger.jpg",
        available: true,
        price: 25,
        groupIds: ["sauce"],
      },
    ],
    groups: new Map([
      [
        "sauce",
        group({
          id: "sauce",
          name: "Sauce",
          min: 1,
          max: 1,
          options: [
            { id: "ketchup", name: "Ketchup", price: 0, available: true },
            { id: "bbq", name: "BBQ", price: 2, available: false },
          ],
        }),
      ],
    ]),
    hours: null,
    ...over,
  };
}

/** Their validation, as our sandbox implements it, run over our own output. */
const sandboxErrors = (catalog: any) => new TalabatSandboxService().validateCatalog({ vendors: ["OH-1"], catalog });

describe("buildTalabatCatalog", () => {
  it("builds a flat catalog their validator accepts", () => {
    const b = buildTalabatCatalog(menu());
    expect(b.problems.filter((p) => p.level === "error")).toEqual([]);
    expect(b.catalog).not.toBeNull();
    const items = b.catalog!.items;
    expect(items.burger).toMatchObject({
      type: "Product",
      price: "25.00",
      active: true,
      title: { default: "Burger", ar: "برجر" },
      toppings: { sauce: { id: "sauce", type: "Topping", order: 0 } },
    });
    expect(items.sauce).toMatchObject({ type: "Topping", quantity: { minimum: 1, maximum: 1 } });
    // Option products live in the hidden add-ons category, out of the menu.
    expect(Object.keys((items[ADDONS_CATEGORY_ID] as any).products)).toEqual(["ketchup", "bbq"]);
    expect(Object.keys((items["menu-m1"] as any).products)).toEqual(["burger"]);
    // An 86'd option goes out inactive, not missing.
    expect(items.bbq).toMatchObject({ active: false, price: "2.00" });
    expect(sandboxErrors(b.catalog)).toEqual([]);
  });

  it("only writes Arabic when the second name IS Arabic", () => {
    const b = buildTalabatCatalog(
      menu({ items: [{ ...menu().items[0]!, secondLanguageName: "Hamburguesa" }] }),
    );
    expect((b.catalog!.items.burger as any).title).toEqual({ default: "Burger" });
  });

  it("sizes become a pick-one first level, each size carrying its own second level", () => {
    const m = menu({
      items: [
        {
          id: "pizza",
          name: "Pizza",
          available: true,
          price: 0,
          groupIds: [],
          sizes: [
            { id: "pizza__size0", name: "Small", price: 30, groupIds: ["extras__small"] },
            { id: "pizza__size1", name: "Large", price: 45, groupIds: ["extras__large"] },
          ],
        },
      ],
      categories: [{ id: "c1", name: "Pizza", itemIds: ["pizza"] }],
      groups: new Map([
        ["extras__small", group({ id: "extras__small", name: "Extras", options: [{ id: "cheese__small", name: "Cheese", price: 3, available: true }] })],
        ["extras__large", group({ id: "extras__large", name: "Extras", options: [{ id: "cheese__large", name: "Cheese", price: 5, available: true }] })],
      ]),
    });
    const b = buildTalabatCatalog(m);
    expect(b.problems.filter((p) => p.level === "error")).toEqual([]);
    const items = b.catalog!.items as any;
    expect(items.pizza.price).toBe("30.00");
    expect(items["pizza__size"].quantity).toEqual({ minimum: 1, maximum: 1 });
    expect(items["pizza__size"].products["pizza__size1"].price).toBe("15.00");
    // Second level hangs off the size, priced per size — exactly.
    expect(Object.keys(items["pizza__size1"].toppings)).toEqual(["extras__large__l2"]);
    expect(items["extras__large__l2"].products["cheese__large"].price).toBe("5.00");
    expect(sandboxErrors(b.catalog)).toEqual([]);
    expect(talabatOptionAliases(b.catalog!, ["cheese"])).toEqual({ cheese: ["cheese__small", "cheese__large"] });
  });

  it("allows follow-up choices under a pick-exactly-one group", () => {
    const m = menu({
      groups: new Map([
        ["sauce", group({ id: "sauce", name: "Sauce", min: 1, max: 1, options: [{ id: "ketchup", name: "Ketchup", price: 0, available: true, groupIds: ["heat"] }] })],
        ["heat", group({ id: "heat", name: "Heat", min: 0, max: 1, options: [{ id: "hot", name: "Hot", price: 1, available: true }] })],
      ]),
    });
    const b = buildTalabatCatalog(m);
    expect(b.problems).toEqual([]);
    expect(Object.keys((b.catalog!.items.ketchup as any).toppings)).toEqual(["heat__l2"]);
    expect(sandboxErrors(b.catalog)).toEqual([]);
  });

  it("REFUSES a required follow-up under a multi-select group (Talabat can't say it)", () => {
    const m = menu({
      groups: new Map([
        ["sauce", group({ id: "sauce", name: "Sauces", min: 0, max: 3, options: [{ id: "ketchup", name: "Ketchup", price: 0, available: true, groupIds: ["heat"] }] })],
        ["heat", group({ id: "heat", name: "Heat", min: 1, max: 1, options: [{ id: "hot", name: "Hot", price: 1, available: true }] })],
      ]),
    });
    const b = buildTalabatCatalog(m);
    expect(b.catalog).toBeNull();
    expect(b.problems[0]!.message).toMatch(/pick-exactly-one/);
  });

  it("drops an OPTIONAL third level with a warning, never silently", () => {
    const m = menu({
      groups: new Map([
        ["sauce", group({ id: "sauce", name: "Sauce", min: 1, max: 1, options: [{ id: "ketchup", name: "Ketchup", price: 0, available: true, groupIds: ["heat"] }] })],
        ["heat", group({ id: "heat", name: "Heat", min: 0, max: 1, options: [{ id: "hot", name: "Hot", price: 1, available: true, groupIds: ["deep"] }] })],
        ["deep", group({ id: "deep", name: "Deep", min: 0, max: 1, options: [{ id: "x", name: "X", price: 0, available: true }] })],
      ]),
    });
    const b = buildTalabatCatalog(m);
    expect(b.catalog).not.toBeNull();
    expect(b.problems.map((p) => p.level)).toEqual(["warning"]);
    expect(b.problems[0]!.message).toMatch(/third/);
    expect(sandboxErrors(b.catalog)).toEqual([]);
  });

  it("refuses an unpriced standalone item and impossible groups", () => {
    const b = buildTalabatCatalog(
      menu({
        items: [{ id: "burger", name: "Burger", available: true, price: 0, groupIds: ["bad"] }],
        groups: new Map([["bad", group({ id: "bad", name: "Pick 3", min: 3, max: 2, options: [{ id: "a", name: "A", price: 0, available: true }] })]]),
      }),
    );
    expect(b.catalog).toBeNull();
    expect(b.problems.map((p) => p.message).join(" ")).toMatch(/requires 3 but allows at most 2/);
    expect(b.problems.map((p) => p.message).join(" ")).toMatch(/has no price/);
  });

  it("tags age-restricted items and skips non-https images with a warning", () => {
    const b = buildTalabatCatalog(
      menu({ items: [{ ...menu().items[0]!, minAge: 18, imageUrl: "http://insecure/x.jpg" }] }),
    );
    expect((b.catalog!.items.burger as any).tags).toEqual({ ageRestrictedItem: ["ID_CHECK_18"] });
    expect((b.catalog!.items.burger as any).images).toBeUndefined();
    expect(b.problems.some((p) => /https/.test(p.message))).toBe(true);
  });
});

describe("tbSchedule", () => {
  it("open all week when no hours are set", () => {
    expect(tbSchedule(null)).toEqual([
      expect.objectContaining({ startTime: "00:00:00", endTime: "23:59:59", weekDays: expect.arrayContaining(["MONDAY", "SUNDAY"]) }),
    ]);
  });

  it("groups days that share a window and splits overnight slots at midnight", () => {
    const s = tbSchedule({
      monday: [{ from: "11:00", to: "23:00" }],
      tuesday: [{ from: "11:00", to: "23:00" }],
      friday: [{ from: "18:00", to: "02:00" }],
    });
    const byWindow = Object.fromEntries(s.map((e) => [`${e.startTime}-${e.endTime}`, e.weekDays]));
    expect(byWindow["11:00:00-23:00:00"]).toEqual(["MONDAY", "TUESDAY"]);
    expect(byWindow["18:00:00-23:59:59"]).toEqual(["FRIDAY"]);
    expect(byWindow["00:00:00-02:00:00"]).toEqual(["SATURDAY"]);
  });
});
