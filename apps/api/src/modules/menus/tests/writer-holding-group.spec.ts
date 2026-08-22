import { MenuWriterService } from "../importers/menu-writer.service";

// The holding group is looked up lazily while creating options. It was looked
// up ONCE PER NEW OPTION — every call after the first returning the same row —
// so importing Best Kebab's 2,325 options spent 2,325 round trips re-reading
// one record, inside a transaction that has a time limit.
function fakeTx(counters: Record<string, number>) {
  const bump = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);
  return {
    modifierOption: {
      findFirst: async () => { bump("option.findFirst"); return null; },
      create: async ({ data }: any) => { bump("option.create"); return { id: `o${counters["option.create"]}`, ...data }; },
      update: async ({ data }: any) => { bump("option.update"); return { id: "o", ...data }; },
      updateMany: async () => { bump("option.updateMany"); return { count: 0 }; },
      findMany: async () => { bump("option.findMany"); return []; },
    },
    modifierGroup: {
      findFirst: async () => { bump("group.findFirst"); return null; },
      create: async ({ data }: any) => { bump("group.create"); return { id: `g${counters["group.create"]}`, ...data }; },
      update: async ({ data }: any) => ({ id: "g", ...data }),
    },
    menuItem: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({ id: "i1", ...data }),
      update: async ({ data }: any) => ({ id: "i1", ...data }),
    },
    menuCategory: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({ id: "c1", ...data }),
      update: async ({ data }: any) => ({ id: "c1", ...data }),
    },
    modifierGroupOnItem: { upsert: async () => ({}) },
    menuItemOnCategory: { upsert: async () => ({}), deleteMany: async () => ({}) },
    modifierOptionNestedGroup: { deleteMany: async () => ({}), upsert: async () => ({}) },
  };
}

function normalizedWith(optionCount: number, groupCount = 0) {
  const perGroup = groupCount ? Math.ceil(optionCount / groupCount) : 0;
  return {
    platformSource: "ai" as const,
    menuPatch: { menuData: {}, rawImportPayload: {}, syncHash: "h" },
    categories: [],
    products: [],
    modifierGroups: Array.from({ length: groupCount }, (_, gi) => ({
      externalId: `grp-${gi}`,
      name: `Group ${gi}`,
      plu: `gp${gi}`,
      selectionType: "ADDON" as const,
      minSelections: 0,
      maxSelections: 5,
      allowDuplicateSelections: true,
      modifierExternalIds: Array.from({ length: perGroup }, (_, i) => `ext-${gi * perGroup + i}`)
        .filter((e) => Number(e.split("-")[1]) < optionCount),
      syncHash: `gh${gi}`,
    })),
    modifiers: Array.from({ length: optionCount }, (_, i) => ({
      externalId: `ext-${i}`,
      name: `Option ${i}`,
      plu: `p${i}`,
      priceAdjustment: 0,
      pricesBySize: {},
      skuPlus: {},
      isAvailable: true,
      visibleToCustomers: true,
      syncHash: `h${i}`,
    })),
    productModifierGroupLinks: [],
    modifierGroupModifierLinks: [],
    optionNestedGroupLinks: [],
    warnings: [],
  };
}

describe("MenuWriterService — the holding group is resolved once per import", () => {
  const build = (counters: Record<string, number>) => {
    const tx = fakeTx(counters);
    const prisma: any = {
      $transaction: async (fn: any) => fn(tx),
      menu: {
        // The writer takes an import lock first; updateMany returning 1 means
        // "acquired".
        updateMany: async () => ({ count: 1 }),
        // No stored hash, so the import is not short-circuited as unchanged.
        findUnique: async () => ({ syncHash: null, syncVersion: 0 }),
        findFirst: async () => ({ id: "m1", brandId: "b1", locationId: "l1" }),
        update: async () => ({}),
      },
      menuItem: { findMany: async () => [] },
      modifierGroup: { findMany: async () => [] },
    };
    return new MenuWriterService(prisma);
  };

  it("looks the holding group up once for 300 new options, not 300 times", async () => {
    const counters: Record<string, number> = {};
    const svc = build(counters);
    await svc.apply({
      menuId: "m1",
      tenantId: "t1",
      brandId: "b1",
      locationId: "l1",
      normalized: normalizedWith(300) as any,
    } as any);

    expect(counters["option.create"]).toBe(300);
    // The holding group is resolved once for the whole import, not per option.
    expect(counters["group.findFirst"]).toBe(1);
    expect(counters["group.create"]).toBe(1);
  });

  it("checks which options already exist in a FIXED number of queries", async () => {
    const run = async (n: number) => {
      const counters: Record<string, number> = {};
      await build(counters).apply({
        menuId: "m1",
        tenantId: "t1",
        brandId: "b1",
        locationId: "l1",
        normalized: normalizedWith(n) as any,
      } as any);
      return counters;
    };
    const small = await run(50);
    const big = await run(500);

    // The per-option existence lookup is gone entirely.
    expect(small["option.findFirst"] ?? 0).toBe(0);
    expect(big["option.findFirst"] ?? 0).toBe(0);
    // Reads no longer scale with the number of options — ten times the
    // options costs the same number of lookups.
    expect(big["option.findMany"]).toBe(small["option.findMany"]);
    // ...while the writes obviously still do.
    expect(big["option.create"]).toBe(500);
    expect(small["option.create"]).toBe(50);
  });

  it("assigns option owners in one query per group, not one per option", async () => {
    // 600 options spread over 20 groups: the owner assignment is identical
    // for every option in a group, so it is 20 writes, not 600.
    const counters: Record<string, number> = {};
    await build(counters).apply({
      menuId: "m1",
      tenantId: "t1",
      brandId: "b1",
      locationId: "l1",
      normalized: normalizedWith(600, 20) as any,
    } as any);

    expect(counters["option.updateMany"]).toBeLessThanOrEqual(20);
    // Not one update per option any more.
    expect(counters["option.update"] ?? 0).toBe(0);
  });
});
