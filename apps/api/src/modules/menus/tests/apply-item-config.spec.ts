import { MenusService } from "../menus.service";

// Applying one item's setup to others. The two halves behave differently on
// purpose: modifier groups are LINKED (shared rows), sizes are COPIED.

const TENANT = "t1";

function makeService(opts: {
  source?: any;
  targets?: Array<{ id: string; plu: string | null }>;
  groupsInTenant?: string[];
} = {}) {
  const updates: any[] = [];
  const createManyCalls: any[] = [];
  const source = opts.source ?? { id: "src", brandId: "b1", plu: "PIZZA", productSkus: [] };
  const targets = opts.targets ?? [{ id: "t1", plu: "MARG" }];
  const prisma: any = {
    menuItem: {
      findUnique: async ({ where }: any) => (where.id === source.id ? source : null),
      findMany: async ({ where }: any) =>
        targets.filter((t) => where.id.in.includes(t.id)),
      update: async (a: any) => {
        updates.push(a);
        return a;
      },
    },
    brand: {
      findFirst: async ({ where }: any) =>
        where.tenantId === TENANT ? { id: "b1" } : null,
      findMany: async () => [{ id: "b1" }],
    },
    modifierGroup: {
      findFirst: async ({ where }: any) =>
        (opts.groupsInTenant ?? ["g1", "g2"]).includes(where.id)
          ? { id: where.id }
          : null,
    },
    modifierGroupOnItem: {
      createMany: async (a: any) => {
        createManyCalls.push(a);
        return { count: a.data.length };
      },
    },
  };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { svc, updates, createManyCalls };
}

describe("applyItemConfigToItems", () => {
  it("links modifier groups to every target", async () => {
    const { svc, createManyCalls } = makeService({
      targets: [
        { id: "t1", plu: "A" },
        { id: "t2", plu: "B" },
      ],
    });
    const res = await svc.applyItemConfigToItems("src", TENANT, {
      targetItemIds: ["t1", "t2"],
      modifierGroupIds: ["g1", "g2"],
    });
    expect(res.itemsUpdated).toBe(2);
    // 2 items x 2 groups
    expect(createManyCalls[0].data).toHaveLength(4);
    // skipDuplicates, NOT create-and-catch: a unique violation inside a
    // transaction aborts the whole transaction in Postgres.
    expect(createManyCalls[0].skipDuplicates).toBe(true);
  });

  it("regenerates SKU PLUs from each target's own PLU", async () => {
    const { svc, updates } = makeService({
      source: {
        id: "src",
        brandId: "b1",
        plu: "PIZZA",
        productSkus: [
          { name: '10"', plu: "PIZZA-1", price: 9.5, modifierGroups: ["g1"] },
          { name: '12"', plu: "PIZZA-2", price: 12.5, modifierGroups: ["g1"] },
        ],
      },
      targets: [
        { id: "t1", plu: "MARG" },
        { id: "t2", plu: "PEPP" },
      ],
    });
    await svc.applyItemConfigToItems("src", TENANT, {
      targetItemIds: ["t1", "t2"],
      includeSkus: true,
    });
    const plus = updates.map((u) => u.data.productSkus.map((s: any) => s.plu));
    // Each target gets ITS OWN codes — copying the source's verbatim would
    // give every pizza the same PLUs and break marketplace catalogues.
    expect(plus).toEqual([
      ["MARG-1", "MARG-2"],
      ["PEPP-1", "PEPP-2"],
    ]);
    // Everything else about the size is carried over untouched.
    expect(updates[0].data.productSkus[0].name).toBe('10"');
    expect(updates[0].data.productSkus[0].price).toBe(9.5);
    expect(updates[0].data.productSkus[0].modifierGroups).toEqual(["g1"]);
    expect(updates[0].data.hasMultipleSkus).toBe(true);
  });

  it("invents a PLU when the target has none, rather than colliding on empty", async () => {
    const { svc, updates } = makeService({
      source: {
        id: "src", brandId: "b1", plu: "PIZZA",
        productSkus: [{ name: '10"', plu: "PIZZA-1", price: 9.5 }],
      },
      targets: [{ id: "t1", plu: null }],
    });
    await svc.applyItemConfigToItems("src", TENANT, {
      targetItemIds: ["t1"],
      includeSkus: true,
    });
    expect(updates[0].data.productSkus[0].plu).toMatch(/^PROD-[A-Z0-9]+-1$/);
  });

  it("refuses an empty selection", async () => {
    const { svc } = makeService();
    await expect(
      svc.applyItemConfigToItems("src", TENANT, { targetItemIds: [] }),
    ).rejects.toThrow(/at least one/i);
  });

  it("ignores the source item if it appears in its own target list", async () => {
    const { svc } = makeService({ targets: [{ id: "t1", plu: "A" }] });
    const res = await svc.applyItemConfigToItems("src", TENANT, {
      targetItemIds: ["src", "t1"],
      modifierGroupIds: ["g1"],
    });
    expect(res.itemsUpdated).toBe(1);
  });

  it("refuses a modifier group from another tenant", async () => {
    const { svc } = makeService({ groupsInTenant: ["g1"] });
    await expect(
      svc.applyItemConfigToItems("src", TENANT, {
        targetItemIds: ["t1"],
        modifierGroupIds: ["someone-elses-group"],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses to copy sizes from an item that has none", async () => {
    const { svc } = makeService();
    await expect(
      svc.applyItemConfigToItems("src", TENANT, {
        targetItemIds: ["t1"],
        includeSkus: true,
      }),
    ).rejects.toThrow(/no sizes/i);
  });
});
