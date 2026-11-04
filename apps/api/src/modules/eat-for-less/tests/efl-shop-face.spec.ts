import { EflService } from "../efl.service";
import { EflPresenceService } from "../efl-presence.service";
import { pinnedBrands, servedMenuBanner, shopBanners, shopFace } from "../efl-shop-face";

// Pizza Uno listed from the "Order Hub" location: the listing's brandId wins.
const orderHubLocation = {
  id: "loc_oh",
  name: "Order Hub Kitchen",
  slug: "order-hub",
  onlineOrderingSlug: null,
  isActive: true,
  deletedAt: null,
  latitude: 54.97,
  longitude: -1.61,
  openingHours: null,
  timezone: "Europe/London",
  addressLine1: "1 High St",
  city: "Newcastle",
  postcode: "NE1 1AA",
  country: "GB",
  brandId: "b_oh",
  brand: { id: "b_oh", name: "Order Hub", logoUrl: "https://cdn/oh.png", tenantId: "t1" },
};
const pizzaUno = { id: "b_uno", name: "Pizza Uno", logoUrl: "https://cdn/uno.png" };

const listing = (extra: any = {}) => ({
  id: "lst_1",
  locationId: "loc_oh",
  brandId: "b_uno",
  listed: true,
  status: "APPROVED",
  hiddenReason: null,
  commissionPercent: null,
  deliveryMode: "OWN_DRIVERS",
  acceptsDelivery: false,
  acceptsCollection: true,
  description: null,
  heroImageUrl: null,
  logoUrl: null,
  cuisines: [],
  lastDeviceSeenAt: null,
  offlineSince: null,
  approvedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  location: orderHubLocation,
  ...extra,
});

describe("shopFace", () => {
  const pinned = new Map([[pizzaUno.id, pizzaUno]]);

  it("shows the listing's own brand over the location's", () => {
    expect(shopFace(listing(), pinned)).toEqual({ name: "Pizza Uno", logoUrl: "https://cdn/uno.png" });
  });

  it("falls back to the location's brand when the listing pins none", () => {
    expect(shopFace(listing({ brandId: null }), pinned)).toEqual({ name: "Order Hub", logoUrl: "https://cdn/oh.png" });
  });

  it("falls back when the pinned brand is gone", () => {
    expect(shopFace(listing(), new Map()).name).toBe("Order Hub");
  });

  it("keeps the listing's own logo upload", () => {
    expect(shopFace(listing({ logoUrl: "https://cdn/own.png" }), pinned).logoUrl).toBe("https://cdn/own.png");
  });

  it("uses the location's name with no brand at all", () => {
    expect(shopFace({ brandId: null, location: { name: "Corner Shop", brand: null } }, new Map()).name).toBe("Corner Shop");
  });
});

describe("pinnedBrands", () => {
  it("skips the query when no listing pins a brand", async () => {
    const prisma = { brand: { findMany: jest.fn() } };
    expect((await pinnedBrands(prisma as any, [{ brandId: null }, {}])).size).toBe(0);
    expect(prisma.brand.findMany).not.toHaveBeenCalled();
  });

  it("fetches each pinned brand once", async () => {
    const prisma = { brand: { findMany: jest.fn(async () => [pizzaUno]) } };
    const map = await pinnedBrands(prisma as any, [{ brandId: "b_uno" }, { brandId: "b_uno" }, { brandId: null }]);
    expect(prisma.brand.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["b_uno"] }, deletedAt: null });
    expect(map.get("b_uno")?.name).toBe("Pizza Uno");
  });
});

describe("EflService shows the listing's brand", () => {
  function setup(rows: any[]) {
    const prisma: any = {
      eflListing: { findMany: jest.fn(async () => rows), findUnique: jest.fn(async () => rows[0]) },
      eflConfig: { findUnique: jest.fn(async () => null) },
      directOrderingConfig: { findMany: jest.fn(async () => []) },
      menuItem: { findMany: jest.fn(async () => []) },
      review: { groupBy: jest.fn(async () => []) },
      brand: { findMany: jest.fn(async () => [pizzaUno]) },
    };
    const ordering: any = { getStorefrontBySlug: jest.fn(async () => ({ name: "store" })) };
    const pauses: any = { isPaused: jest.fn(async () => ({ paused: false })) };
    return new EflService(prisma, ordering, {} as any, pauses);
  }

  it("discover (GET /v1/efl/shops) names and badges the shop as Pizza Uno", async () => {
    const [shop] = await setup([listing()]).discover({ lat: 54.97, lng: -1.61 });
    expect(shop).toMatchObject({ name: "Pizza Uno", logoUrl: "https://cdn/uno.png" });
  });

  it("the menu's listing carries the same name and logo", async () => {
    const res = await setup([listing()]).menu("lst_1");
    expect(res.listing).toMatchObject({ name: "Pizza Uno", logoUrl: "https://cdn/uno.png" });
  });

  it("the Console lists it as Pizza Uno", async () => {
    const [row] = await setup([listing()]).adminListings();
    expect(row.shopName).toBe("Pizza Uno");
  });
});

describe("EflPresenceService texts the listed brand's name", () => {
  it("alerts as Pizza Uno, not the location's brand", async () => {
    const prisma: any = {
      eflListing: {
        findMany: jest.fn(async () => [
          {
            id: "lst_1",
            locationId: "loc_oh",
            brandId: "b_uno",
            hiddenReason: null,
            lastDeviceSeenAt: null,
            location: { name: "Order Hub Kitchen", phone: "+447700900123", openingHours: null, timezone: "Europe/London", brand: { name: "Order Hub" } },
          },
        ]),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({})),
      },
      brand: { findMany: jest.fn(async () => [pizzaUno]) },
    };
    const socket: any = { locationsWithShopDevices: jest.fn(async () => new Set()) };
    const svc = new EflPresenceService(prisma, socket);
    const alert = jest.spyOn(svc as any, "alert").mockResolvedValue(undefined);
    await svc.check(new Date("2026-10-25T18:00:00Z"));
    expect(alert).toHaveBeenCalledWith("+447700900123", "Pizza Uno");
  });
});

describe("card banners — a real picture of the shop", () => {
  const listing = (over: any = {}) => ({ id: "l1", brandId: "b_uno", locationId: "loc_oh", heroImageUrl: null, location: { brandId: "b_oh" }, ...over });
  const prismaWith = (configs: any[]) => ({ directOrderingConfig: { findMany: jest.fn(async () => configs) } });

  it("keeps the listing's own banner and asks for nothing else", async () => {
    const prisma = prismaWith([]);
    const map = await shopBanners(prisma as any, [listing({ heroImageUrl: "https://cdn/own.jpg" })]);
    expect(map.get("l1")).toBe("https://cdn/own.jpg");
    expect(prisma.directOrderingConfig.findMany).not.toHaveBeenCalled();
  });

  it("uses the banner from the shop's own ordering site next", async () => {
    const prisma = prismaWith([{ brandId: "b_uno", locationId: null, heroImageUrl: "https://cdn/site.jpg" }]);
    expect((await shopBanners(prisma as any, [listing()])).get("l1")).toBe("https://cdn/site.jpg");
  });

  it("leaves the rest to the served menu", async () => {
    expect((await shopBanners(prismaWith([]) as any, [listing()])).get("l1")).toBeNull();
  });

  it("takes the served menu's banner, else its first photo", () => {
    expect(servedMenuBanner({ menu: { bannerImage: "https://cdn/menu-banner.jpg", categories: [] } })).toBe("https://cdn/menu-banner.jpg");
    expect(
      servedMenuBanner({ menu: { categories: [{ items: [{ item: { imageUrl: null } }, { item: { imageUrl: "https://cdn/burger.jpg" } }] }] } }),
    ).toBe("https://cdn/burger.jpg");
    expect(servedMenuBanner({ menu: { categories: [] } })).toBeNull();
    expect(servedMenuBanner(null)).toBeNull();
  });
});
