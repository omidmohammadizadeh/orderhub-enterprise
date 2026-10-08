import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MenusService } from "../menus.service";

// "Clone category": copy whole categories from another menu into this one.
// Every product must be a NEW row with a NEW PLU and its own modifier groups —
// sharing a product (or its PLU) with the source menu is what made marking an
// item unavailable in one shop take it off another.

const TENANT = "t1";

const groupDips = {
  id: "g-dips",
  brandId: "b1",
  name: "Choose dips",
  plu: "MOD-OLD1",
  selectionType: "ADDON",
  minSelections: 0,
  maxSelections: 2,
  options: [{ id: "o-garlic", name: "Garlic mayo", priceAdjustment: 0.5, plu: "OPT-OLD1" }],
};

const burrito = {
  id: "i-burrito",
  brandId: "b1",
  locationId: "loc-aylesbury",
  name: "Pollo Burrito",
  plu: "PROD-OLD1",
  basePrice: 9.95,
  productSkus: [],
  modifierGroupLinks: [{ sortOrder: 0, group: groupDips }],
};
const bowl = {
  id: "i-bowl",
  brandId: "b1",
  locationId: "loc-aylesbury",
  name: "Mixed Bowl",
  plu: "PROD-OLD2",
  basePrice: 13.45,
  productSkus: [],
  modifierGroupLinks: [{ sortOrder: 0, group: groupDips }], // same group as the burrito
};

const SOURCE = {
  id: "m-source",
  locationId: "loc-aylesbury",
  categories: [
    { id: "c-tacos", name: "Taco, Burritos, Bowl", sortOrder: 0, description: "Mexican", items: [
      { itemId: burrito.id, sortOrder: 0, priceOverride: null, item: burrito },
      { itemId: bowl.id, sortOrder: 1, priceOverride: 12.5, item: bowl },
    ] },
    { id: "c-meal", name: "MEAL DEALS", sortOrder: 1, items: [
      { itemId: burrito.id, sortOrder: 0, priceOverride: null, item: burrito }, // same product, 2nd category
    ] },
    { id: "c-skip", name: "Drinks", sortOrder: 2, items: [] },
  ],
};
const TARGET = {
  id: "m-target",
  locationId: "loc-pelton",
  categories: [{ id: "c-existing", name: "Meal deals", sortOrder: 4, items: [] }],
};

function harness() {
  let seq = 0;
  const created = { categories: [] as any[], items: [] as any[], links: [] as any[], groups: [] as any[], options: [] as any[] };
  const tx: any = {
    menuCategory: { create: async ({ data }: any) => { const r = { id: `newcat-${++seq}`, ...data }; created.categories.push(r); return r; } },
    menuItemOnCategory: { create: async ({ data }: any) => { created.links.push(data); return data; } },
    menuItem: { create: async ({ data }: any) => { const r = { id: `newitem-${++seq}`, ...data }; created.items.push(r); return r; } },
    modifierGroup: {
      create: async ({ data }: any) => { const r = { id: `newgroup-${++seq}`, ...data }; created.groups.push(r); return r; },
      findFirst: async () => null,
    },
    modifierOption: {
      findMany: async () => [],
      create: async ({ data }: any) => { const r = { id: `newopt-${++seq}`, ...data }; created.options.push(r); return r; },
    },
    modifierOptionNestedGroup: { findMany: async () => [], create: async ({ data }: any) => data },
    modifierGroupOnItem: { create: async ({ data }: any) => data },
  };
  const prisma: any = { $transaction: async (fn: any) => fn(tx) };
  const svc = new MenusService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  (svc as any).findOne = async (id: string, tenantId: string) => {
    if (tenantId !== TENANT) throw new NotFoundException("Menu not found");
    if (id === SOURCE.id) return SOURCE;
    if (id === TARGET.id) return TARGET;
    throw new NotFoundException("Menu not found");
  };
  (svc as any).seedUsedPlus = async (_t: string, used: Set<string>) => {
    for (const p of ["PROD-OLD1", "PROD-OLD2", "MOD-OLD1", "OPT-OLD1"]) used.add(p);
  };
  return { svc, created };
}

describe("MenusService.cloneCategories", () => {
  it("copies the picked categories with brand-new products, groups and PLUs", async () => {
    const { svc, created } = harness();
    const res = await svc.cloneCategories("m-target", TENANT, {
      sourceMenuId: "m-source",
      categoryIds: ["c-tacos", "c-meal"],
    });

    // Categories land after the target's existing ones; a clashing name is marked.
    expect(created.categories.map((c) => [c.name, c.menuId, c.sortOrder])).toEqual([
      ["Taco, Burritos, Bowl", "m-target", 5],
      ["MEAL DEALS (copy)", "m-target", 6],
    ]);
    expect(created.categories[0].description).toBe("Mexican");
    expect(created.categories[0]).not.toHaveProperty("externalId");

    // Two products copied once each (the burrito is in both categories).
    expect(created.items).toHaveLength(2);
    expect(res.itemsCopied).toBe(2);
    for (const it of created.items) {
      expect(it.plu).toBeTruthy();
      expect(["PROD-OLD1", "PROD-OLD2"]).not.toContain(it.plu);
      expect(it.locationId).toBe("loc-pelton"); // homed to the target menu's location
    }
    expect(new Set(created.items.map((i) => i.plu)).size).toBe(2);

    // The shared modifier group is copied ONCE, with new PLUs on group + option.
    expect(created.groups).toHaveLength(1);
    expect(created.groups[0].plu).not.toBe("MOD-OLD1");
    expect(created.options).toHaveLength(1);
    expect(created.options[0].plu).not.toBe("OPT-OLD1");
    expect(res.groupsCopied).toBe(1);

    // Links: tacos has burrito + bowl (bowl keeps its price override); meal deals has the same burrito copy.
    const tacos = created.links.filter((l) => l.categoryId === created.categories[0].id);
    const meal = created.links.filter((l) => l.categoryId === created.categories[1].id);
    expect(tacos.map((l) => l.priceOverride)).toEqual([null, 12.5]);
    expect(meal).toHaveLength(1);
    expect(meal[0].itemId).toBe(tacos[0].itemId);
    expect(res.categories.map((c) => c.items)).toEqual([2, 1]);
  });

  it("refuses an empty pick, a missing source and another tenant", async () => {
    const { svc } = harness();
    await expect(svc.cloneCategories("m-target", TENANT, { sourceMenuId: "m-source", categoryIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.cloneCategories("m-target", TENANT, { categoryIds: ["c-tacos"] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.cloneCategories("m-target", TENANT, { sourceMenuId: "m-source", categoryIds: ["nope"] })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cloneCategories("m-target", "t2", { sourceMenuId: "m-source", categoryIds: ["c-tacos"] })).rejects.toBeInstanceOf(NotFoundException);
  });
});
