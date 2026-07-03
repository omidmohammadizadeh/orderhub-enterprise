import { buildUberEatsMenu } from "../ubereats-menu.transformer";
import type { SrcCategory } from "../../deliveroo/deliveroo-menu.transformer";

// The v2 upsert payload must reference every entity consistently: category
// entities → items, modifier_group_ids → modifier_groups, modifier_options →
// option items. Prices integer pence; titles wrapped in en_us translations.

const CATS: SrcCategory[] = [
  {
    id: "cat-pizza",
    name: "Pizzas",
    description: null,
    products: [
      {
        id: "item-marg",
        name: "Margherita",
        description: "Tomato & mozzarella",
        price: 8.5,
        plu: "PLU-1",
        taxRate: 20,
        imageUrl: "https://img.example.com/marg.jpg",
        available: true,
        groups: [
          {
            id: "grp-toppings",
            name: "Extra toppings",
            minSelections: 0,
            maxSelections: 3,
            selectionType: "ADDON",
            allowDuplicateSelections: false,
            options: [
              { id: "opt-chz", name: "Extra cheese", price: 1.25, plu: "PLU-C", taxRate: 20 },
              { id: "opt-pep", name: "Pepperoni", price: 1.5, plu: null, taxRate: 0 },
            ],
          },
        ],
      },
      {
        id: "item-86d",
        name: "Sold Out Special",
        description: null,
        price: 9.99,
        plu: null,
        taxRate: 20,
        imageUrl: null,
        available: false,
        groups: [],
      },
    ],
  },
  { id: "cat-empty", name: "Empty", description: null, products: [] },
];

describe("buildUberEatsMenu", () => {
  const { payload, stats, warnings } = buildUberEatsMenu({
    menuName: "Main Menu",
    categories: CATS,
  });

  it("emits one all-day menu referencing every non-empty category", () => {
    expect(payload.menus).toHaveLength(1);
    expect(payload.menus[0].category_ids).toEqual(["cat-pizza"]);
    expect(payload.menus[0].title.translations.en_us).toBe("Main Menu");
    expect(payload.menus[0].service_availability).toHaveLength(7);
    expect(payload.menus[0].service_availability[0]).toEqual({
      day_of_week: "monday",
      time_periods: [{ start_time: "00:00", end_time: "23:59" }],
    });
  });

  it("skips empty categories with a warning", () => {
    expect(payload.categories.map((c) => c.id)).toEqual(["cat-pizza"]);
    expect(warnings.join(" ")).toContain("Empty");
  });

  it("lists products as category entities and options as plain items", () => {
    expect(payload.categories[0].entities).toEqual([
      { type: "ITEM", id: "item-marg" },
      { type: "ITEM", id: "item-86d" },
    ]);
    const ids = payload.items.map((i) => i.id).sort();
    expect(ids).toEqual(["item-86d", "item-marg", "opt-chz", "opt-pep"]);
  });

  it("converts prices to integer pence", () => {
    const byId = new Map(payload.items.map((i) => [i.id, i]));
    expect(byId.get("item-marg")!.price_info.price).toBe(850);
    expect(byId.get("opt-chz")!.price_info.price).toBe(125);
    expect(byId.get("opt-pep")!.price_info.price).toBe(150);
  });

  it("defaults a missing/zero tax rate to 20% VAT", () => {
    const byId = new Map(payload.items.map((i) => [i.id, i]));
    expect(byId.get("item-marg")!.tax_info!.tax_rate).toBe(20);
    expect(byId.get("opt-pep")!.tax_info!.tax_rate).toBe(20);
  });

  it("links modifier groups both ways with clamped quantities", () => {
    const marg = payload.items.find((i) => i.id === "item-marg")!;
    expect(marg.modifier_group_ids).toEqual({ ids: ["grp-toppings"] });
    expect(payload.modifier_groups).toHaveLength(1);
    const grp = payload.modifier_groups[0];
    expect(grp.quantity_info.quantity).toEqual({
      min_permitted: 0,
      max_permitted: 3,
    });
    expect(grp.modifier_options).toEqual([
      { type: "ITEM", id: "opt-chz" },
      { type: "ITEM", id: "opt-pep" },
    ]);
  });

  it("suspends unavailable items instead of dropping them", () => {
    const dead = payload.items.find((i) => i.id === "item-86d")!;
    expect(dead.suspension_info?.suspension.suspend_until).toBeGreaterThan(
      4_000_000_000,
    );
    const marg = payload.items.find((i) => i.id === "item-marg")!;
    expect(marg.suspension_info).toBeUndefined();
  });

  it("carries PLUs in external_data and images on items", () => {
    const byId = new Map(payload.items.map((i) => [i.id, i]));
    expect(byId.get("item-marg")!.external_data).toBe("PLU-1");
    expect(byId.get("item-marg")!.image_url).toBe(
      "https://img.example.com/marg.jpg",
    );
    expect(byId.get("opt-pep")!.external_data).toBeUndefined();
  });

  it("reports accurate stats", () => {
    expect(stats).toEqual({ categories: 1, products: 2, groups: 1, options: 2 });
  });
});
