import { OrderingService } from "../ordering.service";

// The app's live map needs the delivery address as a point. Storefront orders
// were only geocoded when someone opened the dispatch map, so a board-
// dispatched order reached the app with no destination (#NU9QY, 19 Oct).
function svc(point: { lat: number; lng: number } | null) {
  const s: any = Object.create(OrderingService.prototype);
  s.prisma = { order: { update: jest.fn().mockResolvedValue({}) } };
  s.geocoder = { geocode: jest.fn().mockResolvedValue(point) };
  return s;
}
const order = (over: any = {}) => ({
  id: "o1",
  status: "OUT_FOR_DELIVERY",
  fulfillmentType: "DELIVERY",
  geocodedAt: null,
  addressLine1: null,
  city: null,
  postcode: null,
  deliveryAddress: { line1: "Sunningdale drive", line2: "5", city: "Washington", postcode: "NE37 2LL" },
  location: { country: "GB" },
  ...over,
});

describe("placeDeliveryAddress", () => {
  it("geocodes the storefront address once and saves it", async () => {
    const s = svc({ lat: 54.92, lng: -1.53 });
    await expect(s.placeDeliveryAddress(order())).resolves.toEqual({ lat: 54.92, lng: -1.53 });
    expect(s.geocoder.geocode).toHaveBeenCalledWith("Sunningdale drive, 5, Washington, NE37 2LL", "GB");
    expect(s.prisma.order.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: expect.objectContaining({ deliveryLat: 54.92, deliveryLng: -1.53 }),
    });
  });

  it("records a failed attempt so a 3 s poll never retries it", async () => {
    const s = svc(null);
    await expect(s.placeDeliveryAddress(order())).resolves.toBeNull();
    expect(s.prisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { geocodedAt: expect.any(Date) } });
  });

  it("leaves finished, pickup and already-tried orders alone", async () => {
    for (const o of [order({ status: "COMPLETED" }), order({ fulfillmentType: "PICKUP" }), order({ geocodedAt: new Date() })]) {
      const s = svc({ lat: 1, lng: 1 });
      await expect(s.placeDeliveryAddress(o)).resolves.toBeNull();
      expect(s.geocoder.geocode).not.toHaveBeenCalled();
    }
  });
});
