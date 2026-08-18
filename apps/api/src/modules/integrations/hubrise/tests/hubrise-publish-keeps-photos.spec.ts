// A republish must never turn a product photo into plain text.
//
// The HubRise catalog PUT replaces the catalog wholesale, so a product sent
// without `image_ids` LOSES the photo HubRise is currently showing. That is not
// hypothetical: Pelton's items point at catalog `we3gg`, which no token in the
// tenant can read any more, so every image upload fails — and before this,
// each republish quietly stripped the photos that were still in the catalog.

import { HubRiseCatalogService, imageIdsByProductRef } from "../hubrise-catalog.service";

const CATALOG_ID = "gmm3n";
/** An imageUrl pointing at a catalog nobody can read — the live Pelton case. */
const DEAD_SRC = "/api/v1/menus/hubrise-image/we3gg/ey463nb";

describe("imageIdsByProductRef", () => {
  it("reads products whether they sit at the top level or under categories", () => {
    const map = imageIdsByProductRef({
      products: [{ ref: "prod_a", image_ids: ["img_a"] }],
      categories: [{ products: [{ ref: "prod_b", image_ids: ["img_b"] }] }],
    });
    expect(map.get("prod_a")).toEqual(["img_a"]);
    expect(map.get("prod_b")).toEqual(["img_b"]);
  });

  it("ignores products with no photo", () => {
    expect(imageIdsByProductRef({ products: [{ ref: "prod_a", image_ids: [] }] }).size).toBe(0);
  });
});

function harness(opts: {
  /** What the live catalog already holds. */
  catalogProducts?: Array<{ ref: string; image_ids?: string[] }>;
  /** Twin MenuItem rows in the tenant, keyed by name. */
  twins?: Array<{ id: string; name: string; imageUrl: string }>;
  /** imageUrls whose bytes can actually be fetched. */
  readable?: string[];
}) {
  const sent: Array<{ method: string; path: string; body: any }> = [];
  const itemUpdates: any[] = [];
  const readable = new Set(opts.readable ?? []);

  const menu = {
    id: "menuA",
    name: "Monster Burgerz",
    brandId: "brandA",
    locationId: "loc1",
    metadata: {},
    pricingVariants: [],
    brand: { id: "brandA", name: "Monster Burgerz", tenantId: "t1" },
    categories: [
      {
        id: "catA",
        name: "Burgers",
        items: [
          {
            item: {
              id: "iA",
              name: "Cheeseburger",
              plu: "A1",
              brandId: "brandA",
              basePrice: 7.5,
              hasMultipleSkus: false,
              productSkus: null,
              modifierGroupLinks: [],
              // Points at the dead catalog, exactly like Pelton's items.
              imageUrl: DEAD_SRC,
            },
          },
        ],
      },
    ],
  };

  const prisma: any = {
    menu: {
      findFirst: async () => menu,
      findMany: async ({ select }: any) => (select ? [{ id: "menuA", metadata: {} }] : [menu]),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    brandPlatformConnection: { findFirst: async () => null },
    brand: { findMany: async () => [{ id: "brandA" }] },
    menuItem: {
      findUnique: async () => ({ id: "iA", name: "Cheeseburger" }),
      findMany: async () => opts.twins ?? [],
      update: async (call: any) => {
        itemUpdates.push(call);
        return {};
      },
    },
    location: {
      findFirst: async () => ({
        id: "loc1",
        hubriseCredentials: { blob: "x" },
        hubriseCatalogId: CATALOG_ID,
        hubriseLocationId: "hl1",
      }),
      findUnique: async () => ({ name: "Pelton" }),
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
    const u = String(url);
    const path = u.replace("https://api.hubrise.com/v1", "");
    const method = init?.method ?? "GET";

    // Reading the live catalog, to carry its photos over.
    if (method === "GET" && path === `/catalogs/${CATALOG_ID}`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: CATALOG_ID, data: { products: opts.catalogProducts ?? [] } }),
        text: async () => "",
      };
    }
    // Fetching image bytes: only the URLs the test declares readable work.
    const img = path.match(/^\/catalogs\/([^/]+)\/images\/([^/]+)\/data$/);
    if (img) {
      const src = `/api/v1/menus/hubrise-image/${img[1]}/${img[2]}`;
      if (!readable.has(src)) return { ok: false, status: 404, text: async () => "" };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0x00]).buffer,
        headers: { get: () => "image/jpeg" },
      };
    }

    // The image upload posts raw bytes, not JSON.
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? "<binary>" : null;
    sent.push({ method, path, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "img_new" }),
      text: async () => JSON.stringify({ id: "img_new" }),
    };
  }) as any;

  return { service, sent, itemUpdates };
}

const putBody = (sent: any[]) => sent.find((r) => r.method === "PUT")!.body;

describe("publishing when the source image is unreadable", () => {
  it("keeps the photo the catalog already has instead of publishing plain", async () => {
    const { service, sent } = harness({
      catalogProducts: [{ ref: "prod_iA", image_ids: ["img_live"] }],
    });

    await service.publishMenu({ tenantId: "t1", menuId: "menuA" });

    const product = putBody(sent).data.products[0];
    expect(product.ref).toBe("prod_iA");
    expect(product.image_ids).toEqual(["img_live"]);
  });

  it("never borrows another product's photo, even one with the same name", async () => {
    // A twin-borrowing fallback used to live here and matched on name ACROSS
    // BRANDS: Smashing Burger's "Fries" took Greek Gyros' "Fries" photo, and
    // the borrowed URL was written back onto the product. Two brands in one
    // kitchen sell identically-named items with different pictures — a name is
    // not an identity. An unreachable source must publish no photo, never
    // someone else's.
    const otherBrandsPhoto = "/api/v1/menus/hubrise-image/622ex/greekgyros99";
    const { service, sent, itemUpdates } = harness({
      catalogProducts: [],
      twins: [{ id: "iGreekGyros", name: "Cheeseburger", imageUrl: otherBrandsPhoto }],
      readable: [otherBrandsPhoto],
    });

    await service.publishMenu({ tenantId: "t1", menuId: "menuA" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    expect(putBody(sent).data.products[0].image_ids).toBeUndefined();
    // Nothing uploaded, and the product's own imageUrl left alone.
    expect(sent.some((r) => r.method === "POST" && r.path.includes("/images"))).toBe(false);
    expect(itemUpdates).toHaveLength(0);
  });

  it("does not invent a photo when the catalog has none either", async () => {
    const { service, sent } = harness({ catalogProducts: [], twins: [] });
    await service.publishMenu({ tenantId: "t1", menuId: "menuA" });
    expect(putBody(sent).data.products[0].image_ids).toBeUndefined();
  });

  it("publishes normally when the catalog cannot be read at all", async () => {
    // A failed catalog GET must never block the publish.
    const { service, sent } = harness({ catalogProducts: [] });
    const realFetch = global.fetch;
    global.fetch = (async (url: string, init: any) => {
      if ((init?.method ?? "GET") === "GET" && String(url).endsWith(`/catalogs/${CATALOG_ID}`)) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      return (realFetch as any)(url, init);
    }) as any;

    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menuA" }),
    ).resolves.toMatchObject({ catalogId: CATALOG_ID });
    expect(putBody(sent).data.products).toHaveLength(1);
  });
});
