import { MenusService } from "../menus.service";

// "Duplicate" on the Products tab: a second product the operator can rename
// and change, independent of the first except for the library's modifier
// groups, which it links to rather than forks.

const TENANT = "t1";

const SRC = {
  id: "i-src",
  brandId: "b1",
  locationId: "loc-pelton",
  name: "Banana Milkshake",
  description: "Thick shake",
  basePrice: 4.99,
  imageUrl: "https://img/x.jpg",
  sku: "SKU-OLD",
  plu: "PROD-OLD111",
  isAvailable: true,
  visibleToCustomers: true,
  outOfStock: true,
  allergens: ["MILK"],
  dietaryTags: [],
  dietary: [],
  calories: null,
  prepTime: null,
  metadata: {},
  hasMultipleSkus: true,
  productSkus: [
    { name: "Regular", price: 4.99, plu: "SKU-AAA", modifierGroups: ["g-toppings"] },
    { name: "Large", price: 5.99, plu: "SKU-BBB", modifierGroups: [] },
  ],
  deliveryTax: 0,
  takeawayTax: 0,
  eatInTax: 0,
  brandIds: [],
  sortOrder: 3,
  isInventoryTracked: false,
  platformPricingOverrides: {},
};

function makeService() {
  const created: any[] = [];
  const links: any[] = [];
  const tx: any = {
    menuItem: {
      create: async ({ data }: any) => {
        const row = { id: "i-copy", ...data };
        created.push(row);
        return row;
      },
    },
    modifierGroupOnItem: {
      createMany: async ({ data }: any) => {
        links.push(...data);
        return { count: data.length };
      },
    },
  };
  const prisma: any = {
    menuItem: {
      findUnique: async ({ where }: any) => (where.id === SRC.id ? SRC : null),
    },
    brand: {
      findFirst: async ({ where }: any) =>
        where.id === "b1" && where.tenantId === TENANT ? { id: "b1" } : null,
    },
    modifierGroupOnItem: {
      findMany: async () => [
        { groupId: "g-sauce", sortOrder: 0 },
        { groupId: "g-toppings", sortOrder: 1 },
      ],
    },
    $transaction: async (fn: any) => fn(tx),
  };
  const plu = { generateUnique: async () => "PROD-NEW999" };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  (svc as any).plu = plu;
  return { svc, created, links };
}

describe("duplicateItem", () => {
  it("makes a new product with a fresh PLU and a (copy) name", async () => {
    const { svc, created } = makeService();
    const copy: any = await svc.duplicateItem(SRC.id, TENANT);
    expect(copy.id).toBe("i-copy");
    expect(created[0].plu).toBe("PROD-NEW999");
    expect(created[0].name).toBe("Banana Milkshake (copy)");
    expect(created[0].sku).toBeNull();
  });

  it("stays at the same location and brand", async () => {
    const { svc, created } = makeService();
    await svc.duplicateItem(SRC.id, TENANT);
    expect(created[0].locationId).toBe("loc-pelton");
    expect(created[0].brandId).toBe("b1");
    expect(created[0].basePrice).toBe(4.99);
  });

  it("clears every size PLU but keeps each size's groups", async () => {
    const { svc, created } = makeService();
    await svc.duplicateItem(SRC.id, TENANT);
    const skus = created[0].productSkus;
    expect(skus.map((s: any) => s.plu)).toEqual([null, null]);
    expect(skus[0].modifierGroups).toEqual(["g-toppings"]);
  });

  it("links the same modifier groups instead of forking them", async () => {
    const { svc, links } = makeService();
    await svc.duplicateItem(SRC.id, TENANT);
    expect(links).toEqual([
      { itemId: "i-copy", groupId: "g-sauce", sortOrder: 0 },
      { itemId: "i-copy", groupId: "g-toppings", sortOrder: 1 },
    ]);
  });

  it("comes back in stock even if the original was 86'd", async () => {
    const { svc, created } = makeService();
    await svc.duplicateItem(SRC.id, TENANT);
    expect(created[0].outOfStock).toBe(false);
  });

  it("refuses another tenant's product", async () => {
    const { svc } = makeService();
    await expect(svc.duplicateItem(SRC.id, "t-other")).rejects.toThrow(
      /not found/i,
    );
  });
});
