import { validateMenuJson } from "@orderhub/shared";

// A menu JSON file has not been through the AI flow's review screen, so this
// is the only thing standing between a typo and a committed menu.
const ok = () => ({
  menuName: "Grill Stop",
  categories: [
    {
      name: "Grilled Meats",
      items: [
        { name: "Quarter Chicken", price: 6.49, modifierGroupKeys: ["g_flavour"] },
        {
          name: "Half Chicken",
          sizes: [
            { name: "On its own", price: 8.99 },
            { name: "Make it meal", price: 12.98 },
          ],
          modifierGroupKeys: ["g_flavour"],
        },
      ],
    },
  ],
  modifierGroups: [
    {
      key: "g_flavour",
      name: "Choose Flavour",
      selectionType: "VARIANT",
      minSelections: 1,
      maxSelections: 1,
      options: [
        { name: "Mild", priceAdjustment: 0 },
        { name: "Extra Hot", priceAdjustment: 0.5 },
      ],
    },
  ],
});

describe("validateMenuJson", () => {
  it("accepts a well-formed menu and summarises what will be created", () => {
    const r = validateMenuJson(ok());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({
      menuName: "Grill Stop",
      categories: 1,
      items: 2,
      modifierGroups: 1,
      options: 2,
      sizedItems: 1,
    });
  });

  // The failure that motivated the validator: a price scraped as text. It
  // would coerce to 0 downstream and commit a free item.
  it("rejects a price written as a string", () => {
    const d: any = ok();
    d.categories[0].items[0].price = "6.49";
    const r = validateMenuJson(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/must be a number/);
    expect(r.errors.join(" ")).toMatch(/Quarter Chicken/);
  });

  it("rejects an item pointing at a modifier group that does not exist", () => {
    const d: any = ok();
    d.categories[0].items[0].modifierGroupKeys = ["g_flavor"]; // spelling typo
    const r = validateMenuJson(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/g_flavor/);
  });

  it("rejects two modifier groups sharing a key", () => {
    const d: any = ok();
    d.modifierGroups.push({ ...d.modifierGroups[0], name: "Other" });
    const r = validateMenuJson(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/more than once/);
  });

  it("rejects a selectionType that is neither VARIANT nor ADDON", () => {
    const d: any = ok();
    d.modifierGroups[0].selectionType = "SINGLE";
    expect(validateMenuJson(d).ok).toBe(false);
  });

  it("rejects min greater than max", () => {
    const d: any = ok();
    d.modifierGroups[0].minSelections = 3;
    d.modifierGroups[0].maxSelections = 1;
    expect(validateMenuJson(d).errors.join(" ")).toMatch(/greater than/);
  });

  it("requires a price on every size", () => {
    const d: any = ok();
    delete d.categories[0].items[1].sizes[1].price;
    const r = validateMenuJson(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/missing a price/);
  });

  it("requires a price on an item with no sizes", () => {
    const d: any = ok();
    delete d.categories[0].items[0].price;
    expect(validateMenuJson(d).ok).toBe(false);
  });

  it("rejects a file that is not an object, or has no categories", () => {
    expect(validateMenuJson([]).ok).toBe(false);
    expect(validateMenuJson("nope").ok).toBe(false);
    expect(validateMenuJson({}).ok).toBe(false);
    expect(validateMenuJson({ categories: [] }).ok).toBe(false);
  });

  // Warnings must NOT block — each of these is a legitimate menu.
  it("warns without blocking on a £0 item, an unused group and a lone size", () => {
    const d: any = ok();
    d.categories[0].items[0].price = 0;
    d.modifierGroups.push({
      key: "g_unused",
      name: "Dips",
      selectionType: "ADDON",
      options: [{ name: "Garlic" }],
    });
    d.categories[0].items[1].sizes = [{ name: "Regular", price: 8.99 }];
    const r = validateMenuJson(d);
    expect(r.ok).toBe(true);
    const w = r.warnings.join(" ");
    expect(w).toMatch(/£0/);
    expect(w).toMatch(/g_unused/);
    expect(w).toMatch(/only one size/);
  });

  it("reports every problem at once, not just the first", () => {
    const d: any = ok();
    d.categories[0].items[0].price = "6.49";
    d.modifierGroups[0].selectionType = "SINGLE";
    expect(validateMenuJson(d).errors.length).toBeGreaterThanOrEqual(2);
  });
});
