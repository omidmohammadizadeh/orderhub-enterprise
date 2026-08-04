import { MenusService } from "../menus.service";

// Modifier groups attached to a multi-SKU product's SIZES.
//
// Those live in productSkus[].modifierGroups as bare id strings with no
// foreign key, so no include tree pulls them. POS resolved them against the
// brand catalogue alone and dropped every group belonging to a different
// brand — the ordinary case on a multi-brand tenant. The size then opened
// with no modifiers while online ordering showed them, because the storefront
// already resolved by id.

const TENANT = "t1";

const GROUPS = [
  { id: "g-same-brand", brandId: "b1", options: [] },
  { id: "g-other-brand", brandId: "b2", options: [] },
  { id: "g-other-tenant", brandId: "b9", options: [] },
];

function makeService() {
  const queries: any[] = [];
  const prisma: any = {
    modifierGroup: {
      findMany: async ({ where }: any) => {
        queries.push(where);
        const ids: string[] = where.id?.in ?? [];
        return GROUPS.filter(
          (g) => ids.includes(g.id) && g.id !== "g-other-tenant",
        );
      },
    },
    modifierOption: { findMany: async () => [] },
  };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { svc, queries };
}

/** A menu whose one product has two sizes, each with its own groups. */
function menuWithSkuGroups(groupIds: string[][]) {
  return {
    categories: [
      {
        items: [
          {
            item: {
              id: "pizza",
              productSkus: groupIds.map((ids, i) => ({
                name: `${10 + i * 2}"`,
                modifierGroups: ids,
              })),
            },
          },
        ],
      },
    ],
  };
}

const resolve = (svc: MenusService, menu: any) =>
  (svc as any).resolveSkuModifierGroups(menu, TENANT);

describe("resolveSkuModifierGroups", () => {
  it("resolves groups referenced by a size", async () => {
    const { svc } = makeService();
    const out = await resolve(svc, menuWithSkuGroups([["g-same-brand"]]));
    expect(out.map((g: any) => g.id)).toEqual(["g-same-brand"]);
  });

  it("resolves groups belonging to another brand — the case POS was missing", async () => {
    const { svc } = makeService();
    const out = await resolve(svc, menuWithSkuGroups([["g-other-brand"]]));
    expect(out.map((g: any) => g.id)).toContain("g-other-brand");
  });

  it("scopes the lookup to the tenant", async () => {
    const { svc, queries } = makeService();
    await resolve(svc, menuWithSkuGroups([["g-same-brand"]]));
    expect(queries[0].brand).toEqual({ tenantId: TENANT });
  });

  it("collects ids across every size, de-duplicated", async () => {
    const { svc, queries } = makeService();
    await resolve(
      svc,
      menuWithSkuGroups([
        ["g-same-brand", "g-other-brand"],
        ["g-same-brand"],
      ]),
    );
    expect([...queries[0].id.in].sort()).toEqual([
      "g-other-brand",
      "g-same-brand",
    ]);
  });

  it("skips the query entirely when no size references a group", async () => {
    const { svc, queries } = makeService();
    expect(await resolve(svc, menuWithSkuGroups([[]]))).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("tolerates a product with no sizes", async () => {
    const { svc } = makeService();
    const menu = { categories: [{ items: [{ item: { id: "x" } }] }] };
    expect(await resolve(svc, menu)).toEqual([]);
  });
});
