import { MenusService } from "../menus.service";

// Modifiers reach a group two ways: the FK (ModifierOption.groupId) and the
// ModifierGroupIds[] array that the catalogue's "Add Existing" button writes.
// Reading `options` alone returns only the FK-primary set, so every read path
// has to fold the array-attached ones in — and it must scope that lookup by
// TENANT, not brand. "Add Existing" happily attaches a modifier owned by
// another brand of the same tenant, and brand-scoping drops exactly those:
// the group then lists four modifiers in one screen and a dozen in another.

const TENANT = "t1";
const BRAND = "b1";

const GROUP = { id: "g1", brandId: BRAND, options: [{ id: "o-fk" }] };

/** Owned by a group in ANOTHER brand, attached to g1 via the array. */
const CROSS_BRAND_OPTION = {
  id: "o-cross-brand",
  modifierGroupIds: ["g1"],
  sortOrder: 1,
};
const SAME_BRAND_OPTION = {
  id: "o-same-brand",
  modifierGroupIds: ["g1"],
  sortOrder: 2,
};

function makeService() {
  const optionQueries: any[] = [];
  const prisma: any = {
    brand: { findFirst: async () => ({ id: BRAND, tenantId: TENANT }) },
    modifierGroup: { findMany: async () => [{ ...GROUP }] },
    modifierOption: {
      findMany: async ({ where }: any) => {
        optionQueries.push(where);
        // Model the two scopes: a tenant-scoped query sees both options, a
        // brand-scoped one only sees the same-brand option.
        const tenantScoped = where.group?.brand?.tenantId === TENANT;
        return tenantScoped
          ? [CROSS_BRAND_OPTION, SAME_BRAND_OPTION]
          : [SAME_BRAND_OPTION];
      },
    },
    // These groups are flat — no option opens another group. The read path
    // still asks, so the delegate has to exist.
    modifierOptionNestedGroup: { findMany: async () => [] },
  };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  (svc as any).assertBrandAccess = async () => ({ id: BRAND });
  (svc as any).resolveCatalogScope = async () => ({
    brandIds: null,
    locationIds: null,
  });
  return { svc, optionQueries };
}

const USER = { tenantId: TENANT, role: "OWNER" } as any;

describe("findModifierGroupsByBrand — array-attached modifiers", () => {
  it("scopes the array lookup by tenant, not brand", async () => {
    const { svc, optionQueries } = makeService();
    await svc.findModifierGroupsByBrand(BRAND, USER);
    expect(optionQueries[0].group).toEqual({ brand: { tenantId: TENANT } });
  });

  it("includes a modifier owned by another brand of the same tenant", async () => {
    const { svc } = makeService();
    const [group] = await svc.findModifierGroupsByBrand(BRAND, USER);
    expect(group.options.map((o: any) => o.id)).toContain("o-cross-brand");
  });

  it("keeps the FK-primary modifiers alongside the attached ones", async () => {
    const { svc } = makeService();
    const [group] = await svc.findModifierGroupsByBrand(BRAND, USER);
    expect(group.options.map((o: any) => o.id)).toEqual([
      "o-fk",
      "o-cross-brand",
      "o-same-brand",
    ]);
  });

  it("does not double-count a modifier that is both FK-primary and attached", async () => {
    const { svc } = makeService();
    (svc as any).prisma.modifierOption.findMany = async () => [
      { id: "o-fk", modifierGroupIds: ["g1"], sortOrder: 1 },
    ];
    const [group] = await svc.findModifierGroupsByBrand(BRAND, USER);
    expect(group.options.map((o: any) => o.id)).toEqual(["o-fk"]);
  });
});
