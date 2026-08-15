import { DeliverooMenuPublishService } from "../deliveroo-menu-publish.service";

// A multi-SKU item — a pizza whose sizes carry their own price and their own
// size-aware modifier prices — goes to Deliveroo as ONE item with a required
// Size group, each size opening its own copy of the groups at that size's
// prices. Deliveroo models that by letting a CHOICE carry modifier_ids, the
// same shape their live menus use for "Make It a Meal → Choose Side".
//
// It used to flatten to one item per size, which put three Margheritas on the
// menu. The size-aware pricing and the off-size hiding below are the reasons
// a single flat item cannot be used instead — they are what the nesting buys.
//
// Drives the private loader with a mocked Prisma.

function makeService(opts: { categories: any[]; groupsById: any[] }) {
  const prisma = {
    menuCategory: { findMany: jest.fn().mockResolvedValue(opts.categories) },
    modifierGroupOnItem: { findMany: jest.fn().mockResolvedValue([]) },
    modifierGroup: { findMany: jest.fn().mockResolvedValue(opts.groupsById) },
  } as any;
  return new DeliverooMenuPublishService(prisma, {} as any, {} as any);
}

const multiSkuCategory = () => ({
  id: "cat1",
  name: "Pizza",
  description: null,
  items: [
    {
      isVisible: true,
      priceOverride: null,
      item: {
        id: "item1",
        name: "Margherita",
        description: "Classic",
        basePrice: 0,
        plu: null,
        sku: null,
        deliveryTax: 20,
        imageUrl: null,
        isAvailable: true,
        hasMultipleSkus: true,
        productSkus: [
          { name: "10 inch", plu: "M10", price: 9.99, modifierGroups: ["grpT"] },
          { name: "12 inch", plu: "M12", price: 12.99, modifierGroups: ["grpT"] },
        ],
      },
    },
  ],
});

const toppingsGroup = () => ({
  id: "grpT",
  name: "Toppings",
  minSelections: 0,
  maxSelections: 3,
  selectionType: "ADDON",
  allowDuplicateSelections: false,
  options: [
    {
      id: "optCheese",
      name: "Extra Cheese",
      priceAdjustment: 0.5,
      plu: "CH",
      deliveryTax: 20,
      isAvailable: true,
      visibleToCustomers: true,
      // size-aware pricing: 10" = 50p, 12" = 75p
      pricesBySize: { "10": 0.5, "12": 0.75 },
      skuPlus: { "10": "CH10", "12": "CH12" },
    },
  ],
});

describe("DeliverooMenuPublishService multi-SKU publishing", () => {
  it("publishes one item whose sizes open their own size-priced groups", async () => {
    const svc = makeService({
      categories: [multiSkuCategory()],
      groupsById: [toppingsGroup()],
    });

    const cats = await (svc as any).loadCategories("m1");
    expect(cats).toHaveLength(1);
    const products = cats[0].products;

    // One tile on the marketplace, not one per size.
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Margherita");
    expect(products[0].id).toBe("item1");
    // Priced at the cheapest size; each size adds its difference.
    expect(products[0].price).toBe(9.99);

    expect(products[0].groups).toHaveLength(1);
    const sizes = products[0].groups[0];
    expect(sizes).toMatchObject({
      name: "Size",
      minSelections: 1,
      maxSelections: 1,
      selectionType: "VARIANT",
    });
    expect(sizes.options.map((o: any) => o.name)).toEqual([
      "10 inch",
      "12 inch",
    ]);
    expect(sizes.options.map((o: any) => o.price)).toEqual([0, 3]);
    // Each size keeps its own PLU so an order line reconciles to the size.
    expect(sizes.options.map((o: any) => o.plu)).toEqual(["M10", "M12"]);

    // 10" opens Toppings at 10" prices…
    const ten = sizes.options[0].nestedGroups[0];
    expect(ten.id).toBe("grpT__10");
    expect(ten.options[0]).toMatchObject({
      id: "optCheese__10",
      name: "Extra Cheese",
      price: 0.5,
      plu: "CH10",
    });

    // …and 12" opens its own copy at 12" prices. Two copies of one group is
    // exactly what lets a single item price a topping per size.
    const twelve = sizes.options[1].nestedGroups[0];
    expect(twelve.id).toBe("grpT__12");
    expect(twelve.options[0]).toMatchObject({
      id: "optCheese__12",
      price: 0.75,
      plu: "CH12",
    });
  });

  it("hides an option not priced for that size", async () => {
    const g = toppingsGroup();
    // Cheese only priced for 10" — it must not appear under 12".
    g.options[0]!.pricesBySize = { "10": 0.5 };
    const svc = makeService({
      categories: [multiSkuCategory()],
      groupsById: [g],
    });

    const cats = await (svc as any).loadCategories("m1");
    const sizes = cats[0].products[0].groups[0];

    expect(sizes.options[0].nestedGroups[0].options).toHaveLength(1);
    // 12" has no valid options left, so the group is dropped from that size
    // rather than published empty.
    expect(sizes.options[1].nestedGroups).toHaveLength(0);
  });
});
