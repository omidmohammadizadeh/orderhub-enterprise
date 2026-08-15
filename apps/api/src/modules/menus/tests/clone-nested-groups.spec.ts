import { MenusService } from "../menus.service";

// Cloning a menu is a DEEP copy: the copy must be editable without touching
// the original. Two things a sized meal-deal menu carries were being copied
// by reference or not at all, so a clone of the Grill Stop menu came out with
// its follow-on choices missing.
//
//   1. ModifierOptionNestedGroup rows — the "Make It a Meal" → Choose Side /
//      Choose Drink links. Never copied, so the clone's meal option was
//      selectable and asked for nothing.
//
//   2. productSkus[].modifierGroups — bare group ids with no FK, copied
//      verbatim. The clone's sizes pointed at the SOURCE menu's groups, so
//      editing the clone changed nothing it actually served.

const TENANT = "t1";

/** Source catalogue, keyed by id, as the tx mock would read it back. */
const GROUPS: Record<string, any> = {
  "g-meal": {
    id: "g-meal",
    brandId: "b1",
    name: "Make It a Meal",
    selectionType: "VARIANT",
    minSelections: 1,
    maxSelections: 1,
    options: [
      { id: "o-own", name: "On Its Own", priceAdjustment: 0 },
      { id: "o-meal", name: "Make It a Meal", priceAdjustment: 3.99 },
    ],
  },
  "g-side": {
    id: "g-side",
    brandId: "b1",
    name: "Choose Side",
    selectionType: "VARIANT",
    minSelections: 1,
    maxSelections: 1,
    options: [{ id: "o-fries", name: "Fries", priceAdjustment: 0 }],
  },
  "g-drink": {
    id: "g-drink",
    brandId: "b1",
    name: "Choose Drink",
    selectionType: "VARIANT",
    minSelections: 1,
    maxSelections: 1,
    options: [{ id: "o-coke", name: "Coke", priceAdjustment: 0 }],
  },
  "g-dip": {
    id: "g-dip",
    brandId: "b1",
    name: "Dip",
    selectionType: "VARIANT",
    minSelections: 1,
    maxSelections: 1,
    options: [{ id: "o-mayo", name: "Garlic Mayo", priceAdjustment: 0.5 }],
  },
  "g-toppings": {
    id: "g-toppings",
    brandId: "b1",
    name: "Extra toppings",
    selectionType: "ADDON",
    minSelections: 0,
    maxSelections: 3,
    options: [{ id: "o-cheese", name: "Extra cheese", priceAdjustment: 1 }],
  },
};

/** optionId → the groups it opens, in ask order. */
const NESTED: Record<string, Array<{ groupId: string; sortOrder: number }>> = {
  "o-meal": [
    { groupId: "g-side", sortOrder: 0 },
    { groupId: "g-drink", sortOrder: 1 },
  ],
  "o-fries": [{ groupId: "g-dip", sortOrder: 0 }],
};

function makeHarness() {
  let seq = 0;
  const createdGroups: any[] = [];
  const createdOptions: any[] = [];
  const createdNested: any[] = [];
  const createdItems: any[] = [];

  const tx: any = {
    modifierGroup: {
      create: async ({ data }: any) => {
        const row = { id: `new-${data.name}-${++seq}`, ...data };
        createdGroups.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => {
        // Mirrors the tenant guard on the real query.
        if (where.brand?.tenantId !== TENANT) return null;
        return GROUPS[where.id] ?? null;
      },
    },
    modifierOption: {
      create: async ({ data }: any) => {
        const row = { id: `newopt-${data.name}-${++seq}`, ...data };
        createdOptions.push(row);
        return row;
      },
    },
    modifierOptionNestedGroup: {
      findMany: async ({ where }: any) => NESTED[where.optionId] ?? [],
      create: async ({ data }: any) => {
        createdNested.push(data);
        return data;
      },
    },
    menuItem: {
      create: async ({ data }: any) => {
        const row = { id: `newitem-${++seq}`, ...data };
        createdItems.push(row);
        return row;
      },
    },
    modifierGroupOnItem: { create: async ({ data }: any) => data },
  };

  const svc = new MenusService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  const caches = {
    itemBySrc: new Map<string, string>(),
    groupBySrc: new Map<string, string>(),
    usedPlus: new Set<string>(),
  };
  return { svc, tx, caches, createdGroups, createdOptions, createdNested, createdItems };
}

const copyGroup = (h: any, srcGroup: any) =>
  (h.svc as any).copyModifierGroupTx(h.tx, srcGroup, TENANT, null, h.caches);

const copyItem = (h: any, src: any) =>
  (h.svc as any).deepCopyItemTx(h.tx, src, TENANT, null, h.caches);

/** The new group row created for a given source group name. */
const newIdFor = (h: any, name: string) =>
  h.createdGroups.find((g: any) => g.name === name)?.id;

describe("clone — nested modifier groups", () => {
  it("copies the groups an option opens", async () => {
    const h = makeHarness();
    await copyGroup(h, GROUPS["g-meal"]);

    expect(h.createdGroups.map((g: any) => g.name).sort()).toEqual([
      "Choose Drink",
      "Choose Side",
      "Dip",
      "Make It a Meal",
    ]);
  });

  it("links the copied option to the COPIED groups, not the originals", async () => {
    // The bug: a clone whose meal option still pointed at the source menu's
    // sides picker, or at nothing.
    const h = makeHarness();
    await copyGroup(h, GROUPS["g-meal"]);

    const mealOption = h.createdOptions.find(
      (o: any) => o.name === "Make It a Meal",
    );
    const links = h.createdNested.filter(
      (l: any) => l.optionId === mealOption.id,
    );
    expect(links.map((l: any) => l.groupId)).toEqual([
      newIdFor(h, "Choose Side"),
      newIdFor(h, "Choose Drink"),
    ]);
    for (const l of links) expect(l.groupId).not.toMatch(/^g-/);
  });

  it("keeps the ask order", async () => {
    const h = makeHarness();
    await copyGroup(h, GROUPS["g-meal"]);
    const mealOption = h.createdOptions.find(
      (o: any) => o.name === "Make It a Meal",
    );
    expect(
      h.createdNested
        .filter((l: any) => l.optionId === mealOption.id)
        .map((l: any) => l.sortOrder),
    ).toEqual([0, 1]);
  });

  it("follows the second level too", async () => {
    // Fries → Dip, inside the copied Choose Side.
    const h = makeHarness();
    await copyGroup(h, GROUPS["g-meal"]);

    const fries = h.createdOptions.find((o: any) => o.name === "Fries");
    expect(
      h.createdNested
        .filter((l: any) => l.optionId === fries.id)
        .map((l: any) => l.groupId),
    ).toEqual([newIdFor(h, "Dip")]);
  });

  it("copies a shared nested group only once", async () => {
    const h = makeHarness();
    await copyGroup(h, GROUPS["g-meal"]);
    await copyGroup(h, GROUPS["g-meal"]);
    expect(
      h.createdGroups.filter((g: any) => g.name === "Choose Side"),
    ).toHaveLength(1);
  });

  it("leaves a flat group alone", async () => {
    const h = makeHarness();
    await copyGroup(h, GROUPS["g-toppings"]);
    expect(h.createdGroups).toHaveLength(1);
    expect(h.createdNested).toEqual([]);
  });
});

describe("clone — per-size modifier groups", () => {
  const SIZED_ITEM = {
    id: "item-1",
    brandId: "b1",
    name: "Margherita",
    basePrice: 8.99,
    hasMultipleSkus: true,
    productSkus: [
      { name: '9 inch', plu: "S9", price: 8.99, modifierGroups: ["g-toppings"] },
      { name: '12 inch', plu: "S12", price: 11.99, modifierGroups: ["g-toppings"] },
    ],
    modifierGroupLinks: [],
  };

  it("repoints each size at the COPIED group", async () => {
    // Copied verbatim, the clone's sizes served the source menu's toppings.
    const h = makeHarness();
    await copyItem(h, SIZED_ITEM);

    const item = h.createdItems[0];
    const copiedId = newIdFor(h, "Extra toppings");
    expect(copiedId).toBeDefined();
    for (const sku of item.productSkus) {
      expect(sku.modifierGroups).toEqual([copiedId]);
    }
  });

  it("copies a group shared by two sizes only once", async () => {
    const h = makeHarness();
    await copyItem(h, SIZED_ITEM);
    expect(
      h.createdGroups.filter((g: any) => g.name === "Extra toppings"),
    ).toHaveLength(1);
  });

  it("clears the size PLUs so the copy carries no colliding codes", async () => {
    const h = makeHarness();
    await copyItem(h, SIZED_ITEM);
    expect(h.createdItems[0].productSkus.map((s: any) => s.plu)).toEqual([
      null,
      null,
    ]);
  });

  it("leaves an id it can't resolve alone rather than dropping the size", async () => {
    const h = makeHarness();
    await copyItem(h, {
      ...SIZED_ITEM,
      productSkus: [
        { name: '9 inch', plu: "S9", price: 8.99, modifierGroups: ["g-ghost"] },
      ],
    });
    expect(h.createdItems[0].productSkus[0].modifierGroups).toEqual(["g-ghost"]);
  });

  it("leaves a flat product's SKUs untouched", async () => {
    const h = makeHarness();
    await copyItem(h, {
      ...SIZED_ITEM,
      hasMultipleSkus: false,
      productSkus: [],
    });
    expect(h.createdItems[0].productSkus).toEqual([]);
  });
});
