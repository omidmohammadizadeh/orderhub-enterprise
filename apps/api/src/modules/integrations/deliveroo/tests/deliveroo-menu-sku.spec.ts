import { DeliverooMenuPublishService } from "../deliveroo-menu-publish.service";

// Multi-SKU items (a pizza with sizes, each carrying its own price + modifier
// groups, with size-aware modifier pricing) must flatten to one Deliveroo item
// per size. This drives the private loader with a mocked Prisma.

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

describe("DeliverooMenuPublishService multi-SKU flattening", () => {
  it("flattens each SKU into its own item with size-aware groups", async () => {
    const svc = makeService({
      categories: [multiSkuCategory()],
      groupsById: [toppingsGroup()],
    });

    const cats = await (svc as any).loadCategories("m1");
    expect(cats).toHaveLength(1);
    const products = cats[0].products;
    expect(products.map((p: any) => p.name)).toEqual([
      "Margherita - 10 inch",
      "Margherita - 12 inch",
    ]);

    const ten = products[0];
    expect(ten.id).toBe("item1__s0");
    expect(ten.price).toBe(9.99);
    expect(ten.plu).toBe("M10");
    expect(ten.groups).toHaveLength(1);
    expect(ten.groups[0].id).toBe("grpT__10");
    expect(ten.groups[0].options[0]).toMatchObject({
      id: "optCheese__10",
      name: "Extra Cheese",
      price: 0.5, // 10" price
      plu: "CH10",
    });

    const twelve = products[1];
    expect(twelve.price).toBe(12.99);
    expect(twelve.plu).toBe("M12");
    expect(twelve.groups[0].id).toBe("grpT__12");
    expect(twelve.groups[0].options[0]).toMatchObject({
      id: "optCheese__12",
      price: 0.75, // 12" price
      plu: "CH12",
    });
  });

  it("hides an option not priced for the selected size", async () => {
    const g = toppingsGroup();
    // Cheese only priced for 10" — should vanish from the 12" item.
    g.options[0]!.pricesBySize = { "10": 0.5 };
    const svc = makeService({
      categories: [multiSkuCategory()],
      groupsById: [g],
    });
    const cats = await (svc as any).loadCategories("m1");
    const [ten, twelve] = cats[0].products;
    expect(ten.groups[0].options).toHaveLength(1);
    // 12" group has no valid options → group dropped entirely.
    expect(twelve.groups).toHaveLength(0);
  });
});
