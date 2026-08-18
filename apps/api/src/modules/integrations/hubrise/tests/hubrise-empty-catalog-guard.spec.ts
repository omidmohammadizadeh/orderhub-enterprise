// Publishing an empty menu must never reach HubRise.
//
// A HubRise publish REPLACES the catalog. An empty menu therefore wipes the
// live one and takes down every storefront it feeds.
//
// This is a real incident, not a hypothetical. Clifton has SIX menus with
// near-identical names all pointing at catalog 622ex, and on 17 Jul 2026 two
// separate zero-item menus were published into it within two hours before
// someone published the real one. A menu with no products is always the
// wrong row picked from a list of duplicates.

import { transformMenuToCatalog } from "../hubrise-catalog.service";

describe("empty catalogs", () => {
  const emptyMenu = {
    id: "m1",
    name: "Master Menu",
    pricingVariants: [],
    categories: [
      // Categories WITHOUT item links — exactly the shape of the four
      // Clifton menus that carried 18 categories and 0 products.
      { id: "c1", name: "Burgers", items: [] },
      { id: "c2", name: "Sides", items: [] },
    ],
  } as any;

  it("a menu with categories but no items produces no products", () => {
    // The precondition the guard fires on. If this ever stops being true,
    // the guard is checking the wrong thing.
    const { products, categories } = transformMenuToCatalog(
      emptyMenu,
      new Map(),
      undefined,
    );
    expect(categories.length).toBeGreaterThan(0);
    expect(products).toHaveLength(0);
  });

  it("a menu with a real item does produce products", () => {
    const menu = {
      ...emptyMenu,
      categories: [
        {
          id: "c1",
          name: "Burgers",
          items: [
            {
              sortOrder: 0,
              item: {
                id: "i1",
                name: "Cheeseburger",
                basePrice: 7.5,
                modifierGroupLinks: [],
              },
            },
          ],
        },
      ],
    } as any;

    const { products } = transformMenuToCatalog(menu, new Map(), undefined);
    expect(products.length).toBeGreaterThan(0);
  });
});
