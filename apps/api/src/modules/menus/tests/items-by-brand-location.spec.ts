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
// menu I'm editing?". With a location named, brand-only rows (locationId null)
// survive only when the shop already sells them — they sit on one of its menus.
// Every menu import writes its products brand-only, so admitting all of them
// listed every import the brand ever ran, at every site.
//
// With a location named the brand is NOT a filter: a menu cloned from another
// shop keeps the source menu's brand, and matching on it hid every product the
// new shop made under its own brand (in Products, missing from the picker).

const TENANT = "t1";
const DUBAI = "loc-dubai";
const LONDON = "loc-london";
const BRAND = "b1";

type Item = {
  id: string;
  brandId: string;
  /** Tenant owning the item's brand. Defaults to TENANT. */
  tenantId?: string;
  locationId: string | null;
  /** Locations whose (live) menus carry this item. */
  onMenusAt?: string[];
};

const ALL_ITEMS: Item[] = [
  { id: "i-dubai", brandId: BRAND, locationId: DUBAI },
  // Brand-only and on the Dubai menu — the shop sells it.
  { id: "i-brand-wide", brandId: BRAND, locationId: null, onMenusAt: [DUBAI] },
  // Brand-only and on no Dubai menu — another site's import.
  { id: "i-imported-elsewhere", brandId: BRAND, locationId: null, onMenusAt: [LONDON] },
  { id: "i-london", brandId: BRAND, locationId: LONDON },
  // Made at Dubai under the shop's own brand — the cloned-menu case.
  { id: "i-other-brand", brandId: "b2", locationId: DUBAI },
  // Another brand, sold at London only.
  { id: "i-other-brand-london", brandId: "b2", locationId: LONDON },
];

/** Stand-in for Prisma's where matching, narrow to what this query uses. */
function matches(it: Item, where: any): boolean {
  if (where.brandId && it.brandId !== where.brandId) return false;
  if (where.brand) {
    if ((it.tenantId ?? TENANT) !== where.brand.tenantId) return false;
    if (where.brand.id?.in && !where.brand.id.in.includes(it.brandId)) return false;
  }
  if (!where.OR) return true;
  return (where.OR as any[]).some((c) => {
    if (c.locationId === null) {
      if (it.locationId !== null) return false;
      const loc = c.categories?.some?.category?.menu?.locationId;
      return loc === undefined || (it.onMenusAt ?? []).includes(loc);
    }
    if (typeof c.locationId === "string") return it.locationId === c.locationId;
    if (c.locationId?.in)
      return it.locationId !== null && c.locationId.in.includes(it.locationId);
    return false;
  });
}

function makeService(opts: {
  assignedLocationIds?: string[] | null;
  /** Brands the caller may see; null = every brand. */
  assignedBrandIds?: string[] | null;
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
    brandIds: opts.assignedBrandIds === undefined ? null : opts.assignedBrandIds,
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

  it("keeps brand-wide products the shop already sells", async () => {
    // Unstamped but on one of this location's menus: it belongs here.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
    expect(ids(rows)).toContain("i-brand-wide");
  });

  it("drops brand-wide products no menu of this shop carries", async () => {
    // The reported leak: every import's products, brand-only, offered to a
    // shop with four products of its own.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
    expect(ids(rows)).not.toContain("i-imported-elsewhere");
  });

  it("offers the shop's products of any brand — a cloned menu keeps its source brand", async () => {
    // The reported bug: a menu cloned into Pelton kept the other shop's brand,
    // so a product made at Pelton under PIZZA UNO showed in Products but not
    // in "Add existing".
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
    expect(ids(rows)).toContain("i-other-brand");
    // ...but still only this shop's.
    expect(ids(rows)).not.toContain("i-other-brand-london");
  });

  it("hides a brand the caller has no access to", async () => {
    const svc = makeService({ assignedBrandIds: [BRAND] });
    const rows = await svc.findItemsByBrand(BRAND, OWNER, DUBAI);
    expect(ids(rows)).toContain("i-dubai");
    expect(ids(rows)).not.toContain("i-other-brand");
  });

  it("keeps the brand match when no location is named", async () => {
    // Brand-wide (legacy) menus have no shop to scope to, so the brand is
    // still the only boundary there.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN);
    expect(ids(rows)).not.toContain("i-other-brand");
  });

  it("never reaches another tenant's products at the location", async () => {
    ALL_ITEMS.push({ id: "i-foreign", brandId: "b9", tenantId: "t2", locationId: DUBAI });
    try {
      const svc = makeService();
      const rows = await svc.findItemsByBrand(BRAND, ADMIN, DUBAI);
      expect(ids(rows)).not.toContain("i-foreign");
    } finally {
      ALL_ITEMS.pop();
    }
  });

  it("leaves the unscoped call alone — a brand-wide menu gets the lot", async () => {
    // Legacy menus carry no locationId and genuinely span every location.
    const svc = makeService();
    const rows = await svc.findItemsByBrand(BRAND, ADMIN);
    expect(ids(rows)).toEqual(
      expect.arrayContaining([
        "i-dubai",
        "i-brand-wide",
        "i-imported-elsewhere",
        "i-london",
      ]),
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
