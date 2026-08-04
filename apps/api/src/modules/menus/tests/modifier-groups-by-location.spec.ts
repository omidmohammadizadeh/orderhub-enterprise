import { MenusService } from "../menus.service";

// Which modifier groups a location may see.
//
// The rule has two halves and both matter. Another site's groups must never
// appear — a multi-site tenant ends up with one "Please select your extra
// toppings" per site and the operator cannot tell them apart. But brand-level
// groups (locationId null) MUST appear: every group created via the product
// editor's "Create New" button was saved without a location until that stamp
// was threaded through, so filtering them out makes real, in-use groups
// vanish from the picker.

const TENANT = "t1";
const LOCATION = "loc-kingston";
const BRAND = "b1";

type Group = {
  id: string;
  brandId: string;
  locationId: string | null;
  options: any[];
};

const ALL_GROUPS: Group[] = [
  { id: "g-kingston", brandId: BRAND, locationId: LOCATION, options: [] },
  { id: "g-brand-level", brandId: BRAND, locationId: null, options: [] },
  { id: "g-other-site", brandId: BRAND, locationId: "loc-croydon", options: [] },
  { id: "g-other-brand", brandId: "b2", locationId: null, options: [] },
];

/** Stand-in for Prisma's OR/equality matching, narrow to what this query uses. */
function matches(g: Group, where: any): boolean {
  return (where.OR as any[]).some((clause) => {
    if (clause.locationId === null) {
      return g.locationId === null && g.brandId === clause.brandId;
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

  it("returns brand-level groups, which is where the product editor put them", async () => {
    const svc = makeService();
    const ids = (await svc.findModifierGroupsByLocation(LOCATION, USER)).map(
      (g: any) => g.id,
    );
    expect(ids).toContain("g-brand-level");
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
