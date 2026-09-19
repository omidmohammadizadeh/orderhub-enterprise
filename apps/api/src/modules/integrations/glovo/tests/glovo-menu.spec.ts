import {
  buildGlovoMenu,
  glovoGroupBounds,
  glovoImage,
  glovoProductIdsFor,
  GLOVO_SECTION_MAX,
  type GlovoSrcCategory,
} from "../glovo-menu.transformer";
import { GlovoMenuPublishService, uploadsInLastDay } from "../glovo-menu-publish.service";

// OrderHub menu → Glovo menu JSON, against the rules of Glovo's live JSON
// Schema (stricter than the prose in the spec).

const sauces = {
  id: "g-sauce",
  name: "Sauces",
  minSelections: 0,
  maxSelections: null,
  allowDuplicateSelections: false,
  options: [
    { id: "o-ketchup", name: "Ketchup", price: 0 },
    { id: "o-mayo", name: "Mayo", price: 0.5 },
  ],
};

const cats: GlovoSrcCategory[] = [
  {
    id: "c1",
    name: "Burgers",
    products: [
      { id: "p1", name: "Beef burger", price: 8.5, imageUrl: "https://cdn.x/p1.jpg", groups: [sauces] },
      { id: "p2", name: "Chicken\nburger", price: 7, imageUrl: "http://insecure/x.jpg", groups: [sauces] },
      { id: "p3", name: "Free dip", price: 0, groups: [] },
    ],
  },
  { id: "c2", name: "Burgers", products: [{ id: "p4", name: "Kids burger", price: 5, groups: [] }] },
  { id: "c3", name: "Empty", products: [] },
];

describe("buildGlovoMenu", () => {
  const { menu, warnings } = buildGlovoMenu({ categories: cats });

  it("leaves out a zero-priced product (the schema rejects it) and says so", () => {
    expect(menu.products.map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
    expect(warnings.join(" ")).toMatch(/Free dip/);
  });

  it("always sends image_url and description keys, null when absent or not https", () => {
    const p2 = menu.products.find((p) => p.id === "p2")!;
    expect(p2).toHaveProperty("image_url", null);
    expect(p2).toHaveProperty("description", null);
    expect(menu.products[0]!.image_url).toBe("https://cdn.x/p1.jpg");
  });

  it("strips line breaks from names", () => {
    expect(menu.products.find((p) => p.id === "p2")!.name).toBe("Chicken burger");
  });

  it("defines each attribute and group ONCE even when several products share it", () => {
    expect(menu.attributes.map((a) => a.id)).toEqual(["o-ketchup", "o-mayo"]);
    expect(menu.attribute_groups).toHaveLength(1);
    expect(menu.attribute_groups[0]).toEqual(
      expect.objectContaining({ id: "g-sauce", min: 0, max: 2, multiple_selection: false }),
    );
  });

  it("gives two categories with the same name distinct collection names (the name IS the id)", () => {
    expect(menu.collections.map((c) => c.name)).toEqual(["Burgers", "Burgers (2)"]);
  });

  it("drops an empty category — a collection needs a section with a product", () => {
    expect(menu.collections.find((c) => c.name === "Empty")).toBeUndefined();
  });

  it("splits a category over 200 products into several sections", () => {
    const many: GlovoSrcCategory = {
      id: "big",
      name: "Big",
      products: Array.from({ length: GLOVO_SECTION_MAX + 5 }, (_, i) => ({
        id: `x${i}`,
        name: `X${i}`,
        price: 1,
        groups: [],
      })),
    };
    const out = buildGlovoMenu({ categories: [many] }).menu;
    expect(out.collections[0]!.sections.map((s) => s.products.length)).toEqual([200, 5]);
  });
});

describe("glovoGroupBounds", () => {
  it("no maximum → the option count (Glovo needs max ≥ 1)", () => {
    expect(glovoGroupBounds({ minSelections: 0, maxSelections: null }, 4)).toEqual({ min: 0, max: 4, clamped: false });
  });
  it("a minimum larger than the options is clamped, so the product stays orderable", () => {
    expect(glovoGroupBounds({ minSelections: 3, maxSelections: 3 }, 2)).toEqual({ min: 2, max: 3, clamped: true });
  });
});

describe("glovoImage", () => {
  it("accepts only https", () => {
    expect(glovoImage("https://a.b/c.png")).toBe("https://a.b/c.png");
    expect(glovoImage("http://a.b/c.png")).toBeNull();
    expect(glovoImage("data:image/png;base64,xx")).toBeNull();
  });
});

describe("glovoProductIdsFor — the 86 must name what publish sent", () => {
  it("a plain item is its own id; a sized item also covers every per-size id", () => {
    expect(glovoProductIdsFor({ id: "i1" })).toEqual(["i1"]);
    expect(
      glovoProductIdsFor({
        id: "i2",
        hasMultipleSkus: true,
        productSkus: [{ name: "10\"" }, null, { name: "12\"" }],
      }),
    ).toEqual(["i2", "i2__s0", "i2__s1"]);
  });
});

describe("uploadsInLastDay", () => {
  it("counts only the last 24 hours", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(
      uploadsInLastDay(["2026-09-18T11:00:00Z", "2026-09-18T13:00:00Z", "2026-09-19T11:00:00Z"], now),
    ).toHaveLength(2);
  });
});

// ── The publish service ─────────────────────────────────────────────────

function makePublisher(opts: { uploads?: string[]; snoozed?: string[] } = {}) {
  let metadata: any = { glovoMenuPublish: { uploads: opts.uploads ?? [] } };
  const item = (id: string, name: string, price: number) => ({
    isVisible: true,
    priceOverride: null,
    item: { id, name, basePrice: price, isAvailable: true, outOfStock: false, imageUrl: null },
  });
  const prisma: any = {
    menu: {
      findFirst: jest.fn(async () => ({ id: "m1", name: "Main", brandId: "b1", locationId: "l1" })),
      update: jest.fn(async () => ({})),
    },
    brandPlatformConnection: {
      findFirst: jest.fn(async (args: any) =>
        args.where.id && args.where.id !== "conn-1"
          ? null
          : { id: "conn-1", tenantId: "t1", brandId: "b1", locationId: "l1", externalStoreId: "OH-1", metadata },
      ),
      findUnique: jest.fn(async () => ({ metadata })),
      update: jest.fn(async ({ data }: any) => {
        metadata = data.metadata;
      }),
    },
    menuCategory: {
      findMany: jest.fn(async () => [
        { id: "c1", name: "Mains", items: [item("i1", "Burger", 9), item("i2", "Wrap", 7)] },
      ]),
    },
    menuItemChannelAvailability: {
      findMany: jest.fn(async () => (opts.snoozed ?? []).map((itemId) => ({ itemId }))),
    },
    modifierGroupOnItem: { findMany: jest.fn(async () => []) },
    modifierGroup: { findMany: jest.fn(async () => []) },
  };
  const client: any = {
    configured: true,
    request: jest.fn(async () => ({ transaction_id: "tx-1" })),
  };
  const config: any = { get: () => "https://api.example.com" };
  const variants: any = { forBrandChannel: jest.fn(async () => null) };
  const svc = new GlovoMenuPublishService(prisma, client, config, variants, { record: jest.fn() } as any);
  return { svc, client, prisma, getMeta: () => metadata };
}

describe("GlovoMenuPublishService", () => {
  it("uploads a menuUrl on OUR https host, and records the token BEFORE the upload", async () => {
    const { svc, client, prisma } = makePublisher();
    const res = await svc.publishMenu({ tenantId: "t1", menuId: "m1" });
    expect(res.transactionId).toBe("tx-1");
    const [method, path, opts] = client.request.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/webhook/stores/OH-1/menu");
    expect(opts.body.menuUrl).toMatch(
      /^https:\/\/api\.example\.com\/api\/v1\/integrations\/glovo\/menu-feed\/conn-1\/[0-9a-f]{48}\.json$/,
    );
    // saveState ran before client.request.
    expect(prisma.brandPlatformConnection.update.mock.invocationCallOrder[0]).toBeLessThan(
      client.request.mock.invocationCallOrder[0],
    );
  });

  it("refuses a sixth upload inside 24 hours without calling Glovo", async () => {
    const recent = Array.from({ length: 5 }, () => new Date().toISOString());
    const { svc, client } = makePublisher({ uploads: recent });
    await expect(svc.publishMenu({ tenantId: "t1", menuId: "m1" })).rejects.toThrow(/5 full menu uploads a day/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("the feed serves the menu only for the current token — anything else is a 404", async () => {
    const { svc, getMeta } = makePublisher();
    await svc.publishMenu({ tenantId: "t1", menuId: "m1" });
    const token = getMeta().glovoMenuPublish.feedToken;
    const menu = await svc.serveFeed({ connectionId: "conn-1", token: `${token}.json` });
    expect(menu.products.map((p) => p.id)).toEqual(["i1", "i2"]);
    await expect(svc.serveFeed({ connectionId: "conn-1", token: "0".repeat(48) })).rejects.toThrow();
  });

  it("publishes an 86'd item as UNAVAILABLE — a full upload must not put it back on sale", async () => {
    const { svc, getMeta } = makePublisher({ snoozed: ["i2"] });
    await svc.publishMenu({ tenantId: "t1", menuId: "m1" });
    const menu = await svc.serveFeed({
      connectionId: "conn-1",
      token: getMeta().glovoMenuPublish.feedToken,
    });
    expect(menu.products.find((p) => p.id === "i2")!.available).toBe(false);
    expect(menu.products.find((p) => p.id === "i1")!.available).toBe(true);
  });
});
