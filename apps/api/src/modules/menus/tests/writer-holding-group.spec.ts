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
      update: async ({ data }: any) => ({ id: "o", ...data }),
      findMany: async () => [],
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

function normalizedWith(optionCount: number) {
  return {
    platformSource: "ai" as const,
    menuPatch: { menuData: {}, rawImportPayload: {}, syncHash: "h" },
    categories: [],
    products: [],
    modifierGroups: [],
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
    // One findFirst per option is the option's OWN existence check. The
    // holding group adds exactly one more for the whole import.
    expect(counters["group.findFirst"]).toBe(1);
    expect(counters["group.create"]).toBe(1);
  });
});
