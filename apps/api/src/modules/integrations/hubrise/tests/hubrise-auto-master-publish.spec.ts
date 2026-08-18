// The rule this whole feature stands on: whichever brand's publish button was
// pressed, the payload HubRise receives contains EVERY brand at that location.
//
// A HubRise catalog PUT replaces the catalog wholesale. Publishing one brand's
// menu into a shared catalog therefore deletes every other brand's products
// and — because that menu only defines its own variants — strips the variants
// each operator selected in their HubRise connection. These tests drive the
// real publishMenu against a fake HubRise and assert on the bytes it sends.

import { HubRiseCatalogService } from "../hubrise-catalog.service";

const CATALOG_ID = "cat1";

const product = (over: Record<string, any>) => ({
  hasMultipleSkus: false,
  basePrice: 5,
  productSkus: null,
  modifierGroupLinks: [],
  imageUrl: null,
  ...over,
});

function menuRow(over: Record<string, any>) {
  return {
    locationId: "loc1",
    metadata: {},
    pricingVariants: [],
    categories: [],
    ...over,
  };
}

const ALPHA = menuRow({
  id: "menuAlpha",
  name: "Alpha Menu",
  brandId: "brandA",
  brand: { id: "brandA", name: "Alpha", tenantId: "t1" },
  metadata: { hubriseAutoMaster: true },
  pricingVariants: [
    {
      ref: "brandA__UBER_EATS",
      name: "Alpha — Uber Eats",
      channelKey: "UBER_EATS",
      brandId: "brandA",
      brandName: "Alpha",
    },
  ],
  categories: [
    {
      id: "catA",
      name: "Burgers",
      items: [{ item: product({ id: "iA", name: "Alpha Burger", plu: "A1", brandId: "brandA" }) }],
    },
  ],
});

const BETA = menuRow({
  id: "menuBeta",
  name: "Beta Menu",
  brandId: "brandB",
  brand: { id: "brandB", name: "Beta", tenantId: "t1" },
  metadata: { hubriseAutoMaster: true },
  categories: [
    {
      id: "catB",
      name: "Wraps",
      items: [{ item: product({ id: "iB", name: "Beta Wrap", plu: "B1", brandId: "brandB" }) }],
    },
  ],
});

/** A menu at the same location that never opted in — e.g. one of Clifton's
 *  duplicate rows, or the old hand-built master menu. */
const STRAY = menuRow({
  id: "menuStray",
  name: "Master Menu-CLIFTON",
  brandId: "brandA",
  brand: { id: "brandA", name: "Alpha", tenantId: "t1" },
  categories: [
    {
      id: "catS",
      name: "Everything",
      items: [{ item: product({ id: "iS", name: "Stray Item", plu: "S1", brandId: "brandA" }) }],
    },
  ],
});

function harness(menus: any[]) {
  const sent: Array<{ method: string; path: string; body: any }> = [];
  const updateManyCalls: any[] = [];

  const byId = new Map(menus.map((m) => [m.id, m]));

  const prisma: any = {
    menu: {
      findFirst: async ({ where }: any) => byId.get(where.id) ?? null,
      findMany: async ({ where, select }: any) => {
        if (select) {
          // Membership probe — every menu at the location.
          return menus.map((m) => ({ id: m.id, metadata: m.metadata }));
        }
        return (where.id.in as string[]).map((id) => byId.get(id));
      },
      updateMany: async (call: any) => {
        updateManyCalls.push(call);
        return { count: call.where.id.in.length };
      },
      update: async () => ({}),
    },
    brandPlatformConnection: { findFirst: async () => null },
    location: {
      findFirst: async () => ({
        id: "loc1",
        hubriseCredentials: { blob: "x" },
        hubriseCatalogId: CATALOG_ID,
        hubriseLocationId: "hl1",
      }),
      findUnique: async () => ({ name: "Clifton" }),
      update: async () => ({}),
    },
    modifierGroup: { findMany: async () => [] },
  };

  const service = new HubRiseCatalogService(
    prisma,
    { get: () => undefined } as any,
    { decrypt: () => ({ accessToken: "tok" }) } as any,
  );

  global.fetch = (async (url: string, init: any) => {
    const path = String(url).replace("https://api.hubrise.com/v1", "");
    sent.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: CATALOG_ID }),
      text: async () => "",
    };
  }) as any;

  return { service, sent, updateManyCalls };
}

const publishedData = (sent: any[]) => sent.find((r) => r.method === "PUT")!.body.data;

describe("publishing one brand's menu into a shared HubRise catalog", () => {
  it("sends every member brand's products, whichever brand was published", async () => {
    for (const clicked of ["menuAlpha", "menuBeta"]) {
      const { service, sent } = harness([ALPHA, BETA]);
      await service.publishMenu({ tenantId: "t1", menuId: clicked });

      const data = publishedData(sent);
      expect(data.products.map((p: any) => p.name).sort()).toEqual([
        "Alpha Burger",
        "Beta Wrap",
      ]);
      expect(data.categories.map((c: any) => c.name).sort()).toEqual(["Burgers", "Wraps"]);
    }
  });

  it("keeps every brand's variant, so nobody has to re-select theirs in HubRise", async () => {
    const { service, sent } = harness([ALPHA, BETA]);
    // Beta pressed publish. Beta's own menu defines no variants at all — the
    // unfixed path would send variants:[] and wipe Alpha's selection.
    await service.publishMenu({ tenantId: "t1", menuId: "menuBeta" });

    const refs = publishedData(sent).variants.map((v: any) => v.ref);
    expect(refs).toContain("brandA__UBER_EATS");
    expect(refs).toContain("brandB__UBER_EATS");
  });

  it("restricts each product to its own brand's variants", async () => {
    const { service, sent } = harness([ALPHA, BETA]);
    await service.publishMenu({ tenantId: "t1", menuId: "menuAlpha" });

    const data = publishedData(sent);
    const refsFor = (name: string) =>
      data.products.find((p: any) => p.name === name).skus[0].restrictions.variant_refs;

    expect(refsFor("Alpha Burger")).toEqual(["brandA__UBER_EATS"]);
    expect(refsFor("Beta Wrap").every((r: string) => r.startsWith("brandB__"))).toBe(true);
  });

  it("names the catalog after the location so publishing never renames it", async () => {
    const { service, sent } = harness([ALPHA, BETA]);
    await service.publishMenu({ tenantId: "t1", menuId: "menuBeta" });
    expect(sent.find((r) => r.method === "PUT")!.body.name).toBe("Clifton");
  });

  it("stamps every member menu as published, not just the clicked one", async () => {
    // MenuAvailabilityService resolves the 86 target catalog from
    // Menu.externalId; an unstamped member would 86 against nothing.
    const { service, updateManyCalls } = harness([ALPHA, BETA]);
    await service.publishMenu({ tenantId: "t1", menuId: "menuAlpha" });

    expect(updateManyCalls).toHaveLength(1);
    expect([...updateManyCalls[0].where.id.in].sort()).toEqual(["menuAlpha", "menuBeta"]);
    expect(updateManyCalls[0].data.externalId).toBe(CATALOG_ID);
  });

  it("refuses to publish a menu that is not in the catalog", async () => {
    const { service, sent } = harness([ALPHA, BETA, STRAY]);
    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menuStray" }),
    ).rejects.toThrow(/not part of this location's HubRise catalog/);
    expect(sent).toHaveLength(0);
  });

  it("refuses when a member brand would contribute nothing", async () => {
    const emptyBeta = menuRow({
      ...BETA,
      categories: [{ id: "catB", name: "Wraps", items: [] }],
    });
    const { service, sent } = harness([ALPHA, emptyBeta]);

    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menuAlpha" }),
    ).rejects.toThrow(/"Beta Menu" is part of this location's HubRise catalog/);
    expect(sent).toHaveLength(0);
  });

  it("refuses when two brands claim the same PLU", async () => {
    const clashing = menuRow({
      ...BETA,
      categories: [
        {
          id: "catB",
          name: "Wraps",
          items: [{ item: product({ id: "iB", name: "Beta Wrap", plu: "A1", brandId: "brandB" }) }],
        },
      ],
    });
    const { service, sent } = harness([ALPHA, clashing]);

    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menuAlpha" }),
    ).rejects.toThrow(/same reference for different things/);
    expect(sent).toHaveLength(0);
  });
});

describe("locations that never opted in", () => {
  it("publishes the clicked menu alone, exactly as before", async () => {
    // The hand-built master menu path. No menu carries the flag, so nothing
    // is composed and the payload is the single menu's own contents.
    const plainAlpha = menuRow({ ...ALPHA, metadata: {} });
    const plainStray = menuRow({ ...STRAY });
    const { service, sent, updateManyCalls } = harness([plainAlpha, plainStray]);

    await service.publishMenu({ tenantId: "t1", menuId: "menuStray" });

    const data = publishedData(sent);
    expect(data.products.map((p: any) => p.name)).toEqual(["Stray Item"]);
    expect(sent.find((r) => r.method === "PUT")!.body.name).toBe("Master Menu-CLIFTON");
    expect(updateManyCalls[0].where.id.in).toEqual(["menuStray"]);
  });
});
