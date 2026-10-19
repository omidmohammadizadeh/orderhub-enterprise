import { OrderingService } from "../ordering.service";

// A multi-shop restaurant app lists the shops its brand trades at, nearest
// first on the phone. Same membership rule as ?brand=: own brand, primary
// location, or listed — never every shop in the tenant.
function svc(brand: any, locations: any[], locate = jest.fn().mockResolvedValue({ lat: 54.9, lng: -1.5 })) {
  const s: any = Object.create(OrderingService.prototype);
  s.prisma = {
    brand: { findUnique: jest.fn().mockResolvedValue(brand) },
    location: { findMany: jest.fn().mockResolvedValue(locations) },
  };
  s.deliveryZones = { locateShop: locate };
  return { s: s as OrderingService, locate, prisma: s.prisma };
}

const loc = (over: any) => ({
  brandId: "placeholder",
  name: "Shop",
  slug: null,
  onlineOrderingSlug: null,
  addressLine1: "1 High St",
  city: "Newcastle",
  postcode: "NE1 1AA",
  phone: null,
  timezone: "Europe/London",
  openingHours: [],
  latitude: null,
  longitude: null,
  ...over,
});

describe("OrderingService.brandShops", () => {
  it("lists the brand's shops, geocoding only the ones without a position", async () => {
    const { s, locate } = svc(
      { id: "b1", name: "PIZZA UNO", logoUrl: null, primaryLocationId: "l1", locations: [{ id: "l2" }] },
      [
        loc({ id: "l1", name: "Clifton", latitude: 55.0, longitude: -1.6, onlineOrderingSlug: "pizza-uno" }),
        loc({ id: "l2", name: "Pelton" }),
      ],
    );
    const out = await s.brandShops("b1");
    expect(out.shops.map((x: any) => [x.locationId, x.storeSlug, x.lat])).toEqual([
      ["l1", "pizza-uno", 55.0],
      ["l2", "l2", 54.9],
    ]);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate).toHaveBeenCalledWith("l2");
  });

  it("drops a shop the query matched but the brand does not serve", async () => {
    const { s } = svc({ id: "b1", name: "X", logoUrl: null, primaryLocationId: null, locations: [] }, [
      loc({ id: "l9", brandId: "someone-else" }),
    ]);
    expect((await s.brandShops("b1")).shops).toEqual([]);
  });

  it("still lists a shop that can't be placed on the map", async () => {
    const { s } = svc(
      { id: "b1", name: "X", logoUrl: null, primaryLocationId: "l1", locations: [] },
      [loc({ id: "l1" })],
      jest.fn().mockResolvedValue(null),
    );
    const [shop] = (await s.brandShops("b1")).shops;
    expect(shop).toMatchObject({ locationId: "l1", lat: null, lng: null });
  });
});
