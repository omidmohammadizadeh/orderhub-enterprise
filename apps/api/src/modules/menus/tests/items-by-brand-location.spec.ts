import { MenusService } from "../menus.service";

// Which products the menu editor's "Add existing product" picker may offer.
//
// The picker is brand-scoped, which is the whole brand's library across every
// shop it runs. For a tenant whose brand trades in two countries that means a
// Dubai menu was offered the UK shop's products, priced in pounds — and a
// platform admin saw the lot, because the role scope that narrows this for
// ordinary staff returns "everything" for an admin.
//
// So the location is now a filter in its own right: the role scope answers
// "are you allowed to see this?", the location answers "does it belong on the
// menu I'm editing?". Brand-only rows (locationId null) survive both, because
// an unassigned library product belongs to every shop of the brand and every
// group the product editor created before the location stamp was threaded
// through is one of them.

const TENANT = "t1";
const DUBAI = "loc-dubai";
const LONDON = "loc-london";
const BRAND = "b1";

type Item = { id: string; brandId: string; locationId: string | null };

const ALL_ITEMS: Item[] = [
  { id: "i-dubai", brandId: BRAND, locationId: DUBAI },
  { id: "i-brand-wide", brandId: BRAND, locationId: null },
  { id: "i-london", brandId: BRAND, locationId: LONDON },
  { id: "i-other-brand", brandId: "b2", locationId: DUBAI },
];

/** Stand-in for Prisma's where matching, narrow to what this query uses. */
function matches(it: Item, where: any): boolean {
  if (where.brandId && it.brandId !== where.brandId) return false;
  if (!where.OR) return true;
  return (where.OR as any[]).some((c) => {
    if (c.locationId === null) return it.locationId === null;
    if (typeof c.locationId === "string") return it.locationId === c.locationId;
    if (c.locationId?.in)
      return it.locationId !== null && c.locationId.in.includes(it.locationId);
    return false;
  });
}

function makeService(opts: {
  assignedLocationIds?: string[] | null;
  knownLocationIds?: string[];
} = {}) {
  const known = opts.knownLocationIds ?? [DUBAI, LONDON];
  const prisma: any = {
    brand: {
      findFirst: async ({ where }: any) =>
        where.id === BRAND && where.tenantId === TENANT
          ? { id: BRAND, tenantId: TENANT }
          : null,
    },
    location: {
      findFirst: async ({ where }: any) =>
        known.includes(where.id) ? { id: where.id, brandId: BRAND } : null,
    },
    menuItem: {
      findMany: async ({ where }: any) =>
        ALL_ITEMS.filter((i) => matches(i, where)),
    },
  };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  (svc as any).resolveCatalogScope = async () => ({
    brandIds: null,
    locationIds:
      opts.assignedLocationIds === undefined ? null : opts.assignedLocationIds,
  });
  return svc;
}

const ADMIN = { tenantId: TENANT, role: "PLATFORM_ADMIN" } as any;
const OWNER = { tenantId: TENANT, role: "OWNER" } as any;

const ids = (rows: any[]) => rows.map((r) => r.id);

describe("findItemsByBrand, scoped to a location", () => {
  it("never offers a sibling location's products, admin or not", async () => {
    // The reported bug: a Dubai menu listing the UK shop's catalogue.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
    expect(ids(rows)).toContain("i-dubai");
    expect(ids(rows)).not.toContain("i-london");
  });

  it("keeps brand-wide products, which is where most of them live", async () => {
    // A product never stamped with a location belongs to every shop of the
    // brand. Dropping these would empty the picker for any tenant that
    // built its catalogue before the stamp existed.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
    expect(ids(rows)).toContain("i-brand-wide");
  });

  it("still never crosses a brand", async () => {
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
    expect(ids(rows)).not.toContain("i-other-brand");
  });

  it("leaves the unscoped call alone — a brand-wide menu gets the lot", async () => {
    // Legacy menus carry no locationId and genuinely span every location.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN);
    expect(ids(rows)).toEqual(
      expect.arrayContaining(["i-dubai", "i-brand-wide", "i-london"]),
    );
  });

  it("still applies the role scope when no location is named", async () => {
    const svc = makeService({ assignedLocationIds: [DUBAI] });
    const rows = await svc.findItemsByBrand(BRAND, OWNER);
    expect(ids(rows)).toContain("i-dubai");
    expect(ids(rows)).toContain("i-brand-wide");
    expect(ids(rows)).not.toContain("i-london");
  });

  it("refuses a location the caller isn't assigned to", async () => {
    // The id comes from a browser. Narrowing must not become a way to widen.
    const svc = makeService({ assignedLocationIds: [DUBAI] });
    expect(await svc.findItemsByBrand(BRAND, OWNER, LONDON)).toEqual([]);
  });

  it("refuses a location outside the tenant", async () => {
    const svc = makeService();
    await expect(
      svc.findItemsByBrand(BRAND, ADMIN, "loc-someone-elses"),
    ).rejects.toThrow(/Location not found/i);
  });

  it("refuses a brand outside the tenant", async () => {
    const svc = makeService();
    await expect(
      svc.findItemsByBrand("b-someone-elses", ADMIN, DUBAI),
    ).rejects.toThrow(/Brand not found/i);
  });
});
