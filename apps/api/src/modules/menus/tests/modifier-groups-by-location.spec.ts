import { MenusService } from "../menus.service";

// Which modifier groups a location may see.
//
// The rule has two halves and both matter. Another site's groups must never
// appear — a multi-site tenant ends up with one "Please select your extra
// toppings" per site and the operator cannot tell them apart. But brand-level
// groups (locationId null) the shop USES must appear: every group created via
// the product editor's "Create New" button was saved without a location until
// that stamp was threaded through. Brand-level groups nothing here uses must
// not — menu imports write all theirs brand-only, plus empty
// "__import_holding" groups, and they flooded every site's picker.

const TENANT = "t1";
const LOCATION = "loc-kingston";
const BRAND = "b1";

type Group = {
  id: string;
  brandId: string;
  locationId: string | null;
  options: any[];
  /** Linked (ModifierGroupOnItem) to one of this location's products. */
  usedHere?: boolean;
};

const ALL_GROUPS: Group[] = [
  { id: "g-kingston", brandId: BRAND, locationId: LOCATION, options: [] },
  { id: "g-brand-level", brandId: BRAND, locationId: null, options: [], usedHere: true },
  { id: "g-sku-only", brandId: BRAND, locationId: null, options: [] },
  { id: "g-import-holding", brandId: BRAND, locationId: null, options: [] },
  { id: "g-other-site", brandId: BRAND, locationId: "loc-croydon", options: [] },
  { id: "g-other-brand", brandId: "b2", locationId: null, options: [], usedHere: true },
];

/** Stand-in for Prisma's OR/equality matching, narrow to what this query uses. */
function matches(g: Group, where: any): boolean {
  return (where.OR as any[]).some((clause) => {
    if (clause.locationId === null) {
      if (g.locationId !== null || g.brandId !== clause.brandId) return false;
      return (clause.OR as any[]).some((c) =>
        c.itemLinks ? !!g.usedHere : (c.id?.in ?? []).includes(g.id),
      );
    }
    return g.locationId === clause.locationId;
  });
}

function makeService(opts: { assignedLocationIds?: string[] | null } = {}) {
  const prisma: any = {
    location: {
      findFirst: async ({ where }: any) =>
        where.id === LOCATION ? { id: LOCATION, brandId: BRAND } : null,
    },
    modifierGroup: {
      findMany: async ({ where }: any) =>
        ALL_GROUPS.filter((g) => matches(g, where)),
    },
    modifierOption: { findMany: async () => [] },
    // This location's products; one size points at g-sku-only.
    menuItem: {
      findMany: async () => [
        { productSkus: [{ modifierGroups: ["g-sku-only"] }] },
        { productSkus: [] },
      ],
    },
  };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  // resolveCatalogScope reads assignments off the user; stub it so the test
  // targets the location filter rather than the role plumbing.
  (svc as any).resolveCatalogScope = async () => ({
    brandIds: null,
    locationIds:
      opts.assignedLocationIds === undefined
        ? null
        : opts.assignedLocationIds,
  });
  return svc;
}

const USER = { tenantId: TENANT, role: "OWNER" } as any;

describe("findModifierGroupsByLocation", () => {
  it("returns the location's own groups", async () => {
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).toContain("g-kingston");
  });

  it("returns brand-level groups this location's products use", async () => {
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).toContain("g-brand-level");
  });

  it("returns brand-level groups reached only through a product's size", async () => {
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).toContain("g-sku-only");
  });

  it("drops brand-level groups nothing at this location uses", async () => {
    // The reported leak: import holding groups and other imports' groups.
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).not.toContain("g-import-holding");
  });

  it("never returns another site's groups", async () => {
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).not.toContain("g-other-site");
  });

  it("does not leak another brand's brand-level groups", async () => {
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).not.toContain("g-other-brand");
  });

  it("returns nothing when the user isn't assigned to the location", async () => {
    const svc = makeService({ assignedLocationIds: ["loc-croydon"] });
    expect(await svc.findModifierGroupsByLocation(LOCATION, USER)).toEqual([]);
  });
});
