import { JetGoDispatchService } from "../jet-go-dispatch.service";

// The /estimate payload. Every assertion here is a documented JET rule that
// fails as an opaque 400 (or, worse, a delivery to the wrong place) when broken.

type Row = Record<string, any>;

function svc(over: { geocode?: any } = {}) {
  const s: any = Object.create(JetGoDispatchService.prototype);
  s.prisma = {};
  s.wallet = { dispatchFeeMinor: () => 50 };
  s.geocoding = { geocode: over.geocode ?? jest.fn().mockResolvedValue(null) };
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return s;
}

const cfg = (over: Row = {}): any => ({
  tenantId: "t1",
  locationId: "loc1",
  market: "UK",
  environment: "sandbox",
  clientId: "id",
  clientSecret: "sec",
  collectPointId: "cp-1",
  collectPointName: "Shop",
  webhookToken: "tok",
  active: true,
  ...over,
});

const location = (over: Row = {}): Row => ({
  id: "loc1",
  name: "Shop",
  country: "GB",
  currency: "GBP",
  prepTime: 20,
  ...over,
});

const order = (over: Row = {}): Row => ({
  id: "clorderid00000000",
  tenantId: "t1",
  locationId: "loc1",
  displayId: "A-1042",
  customerName: "Sam Patel",
  customerPhone: "+447700900123",
  customerInfo: { email: "sam@example.com" },
  deliveryAddress: { line1: "12 Bannatyne Ave", city: "London", postcode: "SW1A 1AA" },
  deliveryLat: 51.501285,
  deliveryLng: -0.142442,
  items: [{ quantity: 2 }, { quantity: 1 }],
  total: "24.50",
  tipAmount: "3.00",
  paymentMethod: "CARD",
  metadata: {},
  ...over,
});

describe("JET Go estimate payload", () => {
  it("sends coordinates as [latitude, longitude], not GeoJSON order", async () => {
    const { body } = await svc().buildEstimateBody(order(), location(), cfg());
    // 51.5 is London's LATITUDE. Reversed, this delivery lands in the ocean off
    // west Africa, and JET's `type: "point"` invites exactly that mistake.
    expect(body.delivery.geolocation!.coordinates).toEqual([51.501285, -0.142442]);
    expect(body.delivery.geolocation!.type).toBe("point");
  });

  it("uses the configured collect point, because JET takes no pickup address", async () => {
    const { body } = await svc().buildEstimateBody(order(), location(), cfg());
    expect(body.collect).toEqual({ id: "cp-1" });
  });

  it("refuses to dispatch when no collect point has been chosen", async () => {
    await expect(
      svc().buildEstimateBody(order(), location(), cfg({ collectPointId: null })),
    ).rejects.toThrow(/collect point/i);
  });

  it("clamps preparationDuration into JET's 5–60 window", async () => {
    const long = await svc().buildEstimateBody(
      order({ preparationMinutes: 90 }),
      location(),
      cfg(),
    );
    expect(long.body.deliveryDetails!.preparationDuration).toBe(60);
    const short = await svc().buildEstimateBody(
      order({ preparationMinutes: 1 }),
      location(),
      cfg(),
    );
    expect(short.body.deliveryDetails!.preparationDuration).toBe(5);
  });

  it("reads the address from the structured columns when the JSON blob is empty", async () => {
    // A till-placed order fills the columns and leaves deliveryAddress null.
    // Reading only the blob refused to dispatch every counter order.
    const { body } = await svc().buildEstimateBody(
      order({
        deliveryAddress: null,
        addressLine1: "4 High Street",
        city: "Leeds",
        postcode: "LS1 4DT",
      }),
      location(),
      cfg(),
    );
    expect(body.delivery.address).toBe("4 High Street");
    expect(body.delivery.city).toBe("Leeds");
    expect(body.delivery.postalCode).toBe("LS1 4DT");
  });

  it("refuses an order with no town/city, which JET requires", async () => {
    await expect(
      svc().buildEstimateBody(
        order({ deliveryAddress: { line1: "12 Bannatyne Ave", postcode: "SW1A 1AA" } }),
        location(),
        cfg(),
      ),
    ).rejects.toThrow(/town\/city/i);
  });

  it("refuses an order with no customer phone", async () => {
    await expect(
      svc().buildEstimateBody(order({ customerPhone: "  " }), location(), cfg()),
    ).rejects.toThrow(/phone/i);
  });

  it("geocodes only when the order has no usable coordinates", async () => {
    const geocode = jest.fn().mockResolvedValue({ lat: 53.8, lng: -1.5 });
    const s = svc({ geocode });
    await s.buildEstimateBody(order(), location(), cfg());
    expect(geocode).not.toHaveBeenCalled();

    const { body } = await s.buildEstimateBody(
      order({ deliveryLat: null, deliveryLng: null }),
      location(),
      cfg(),
    );
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(body.delivery.geolocation!.coordinates).toEqual([53.8, -1.5]);
  });

  it("treats 0,0 as no coordinates", async () => {
    const geocode = jest.fn().mockResolvedValue({ lat: 53.8, lng: -1.5 });
    await svc({ geocode }).buildEstimateBody(
      order({ deliveryLat: 0, deliveryLng: 0 }),
      location(),
      cfg(),
    );
    expect(geocode).toHaveBeenCalled();
  });

  it("prefers coordinates the marketplace already sent in the blob over geocoding", async () => {
    const geocode = jest.fn().mockResolvedValue({ lat: 1, lng: 1 });
    const { body } = await svc({ geocode }).buildEstimateBody(
      order({
        deliveryLat: null,
        deliveryLng: null,
        deliveryAddress: {
          line1: "12 Bannatyne Ave",
          city: "London",
          postcode: "SW1A 1AA",
          latitude: 51.4,
          longitude: -0.1,
        },
      }),
      location(),
      cfg(),
    );
    expect(geocode).not.toHaveBeenCalled();
    expect(body.delivery.geolocation!.coordinates).toEqual([51.4, -0.1]);
  });

  it("refuses an EU-market order it cannot get coordinates for", async () => {
    await expect(
      svc().buildEstimateBody(
        order({ deliveryLat: null, deliveryLng: null }),
        location({ country: "NL" }),
        cfg({ market: "EU" }),
      ),
    ).rejects.toThrow(/coordinates/i);
  });

  it("omits unreachablePreference in EU markets, which don't support it", async () => {
    const eu = await svc().buildEstimateBody(order(), location({ country: "NL" }), cfg({ market: "EU" }));
    expect(eu.body.deliveryOptions!.unreachablePreference).toBeUndefined();
    const uk = await svc().buildEstimateBody(order(), location(), cfg());
    expect(uk.body.deliveryOptions!.unreachablePreference).toBe("RETURN");
  });

  it("never sends the deprecated top-level hasAlcohol flag", async () => {
    // JET errors and discards the estimate if the old flag is true, so alcohol
    // only ever goes inside deliveryDetails.
    const { body } = await svc().buildEstimateBody(
      order({ metadata: { hasAlcohol: true } }),
      location(),
      cfg(),
    );
    expect((body as any).hasAlcohol).toBeUndefined();
    expect(body.deliveryDetails!.hasAlcohol).toBe(true);
    expect(body.deliveryDetails!.ageRestriction).toBe(18);
  });

  it("schedules an advance order only inside JET's 1h–5d window", async () => {
    const inWindow = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const tooSoon = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const tooFar = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();

    const a = await svc().buildEstimateBody(order({ scheduledFor: inWindow }), location(), cfg());
    expect(a.body.targetDeliverTime).toBe(new Date(inWindow).toISOString());

    const b = await svc().buildEstimateBody(order({ scheduledFor: tooSoon }), location(), cfg());
    expect(b.body.targetDeliverTime).toBeUndefined();
    expect(b.warnings.join(" ")).toMatch(/ASAP/i);

    const d = await svc().buildEstimateBody(order({ scheduledFor: tooFar }), location(), cfg());
    expect(d.body.targetDeliverTime).toBeUndefined();
  });

  it("never sends an advance order to an EU market, which doesn't take them", async () => {
    const when = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const { body, warnings } = await svc().buildEstimateBody(
      order({ scheduledFor: when }),
      location({ country: "NL" }),
      cfg({ market: "EU" }),
    );
    expect(body.targetDeliverTime).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/advance orders/i);
  });

  it("warns loudly about a cash order no courier will collect", async () => {
    const { warnings } = await svc().buildEstimateBody(
      order({ paymentMethod: "CASH" }),
      location(),
      cfg(),
    );
    expect(warnings.join(" ")).toMatch(/will not collect cash/i);
  });

  it("estimates a weight rather than claiming a precision we don't have", async () => {
    const { body } = await svc().buildEstimateBody(order(), location(), cfg());
    expect(body.deliveryDetails!.weightGrams).toBe(1500); // 3 units × 500g
    const empty = await svc().buildEstimateBody(order({ items: [] }), location(), cfg());
    expect(empty.body.deliveryDetails!.weightGrams).toBe(500);
  });

  it("caps fields at JET's documented lengths", async () => {
    const { body } = await svc().buildEstimateBody(
      order({
        customerName: "N".repeat(150),
        deliveryAddress: { line1: "A".repeat(400), city: "C".repeat(80), postcode: "P".repeat(30) },
      }),
      location(),
      cfg(),
    );
    expect(body.delivery.name).toHaveLength(100);
    expect(body.delivery.address).toHaveLength(255);
    expect(body.delivery.city).toHaveLength(50);
    expect(body.delivery.postalCode).toHaveLength(15);
  });
});

describe("JET Go delivery payload", () => {
  const estimate: any = { requestId: "req-1", dynamicDeliveryFee: 350 };

  it("sends a human-readable vendorOrderId, never a UUID", async () => {
    const body = svc().buildDeliveryBody(order(), estimate, null);
    // The courier reads this at pickup; JET's spec asks explicitly for something
    // that isn't a UUID.
    expect(body.vendorOrderId).toBe("A-1042");
    expect(body.vendorOrderId).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("falls back to the order number, then to a short tail of the id", async () => {
    expect(
      svc().buildDeliveryBody(order({ displayId: null, orderNumber: 77 }), estimate, null)
        .vendorOrderId,
    ).toBe("77");
    // Last resort: the tail of the cuid, uppercased — short enough to read out
    // over the phone, and still not the full UUID-ish id JET asks us to avoid.
    expect(
      svc().buildDeliveryBody(
        order({ id: "clxyz1234abcd5678", displayId: null, orderNumber: null }),
        estimate,
        null,
      ).vendorOrderId,
    ).toBe("ABCD5678");
  });

  it("never passes the restaurant's tip to the courier", async () => {
    // Order.tipAmount is the SHOP's gratuity. Sending it as JET's `tip` would
    // hand the shop's money to the courier on every dispatch.
    const body = svc().buildDeliveryBody(order(), estimate, null);
    expect(body.tip).toBeUndefined();
  });

  it("sends orderValue in minor units", async () => {
    expect(svc().buildDeliveryBody(order({ total: "24.50" }), estimate, null).orderValue).toBe(2450);
  });

  it("carries our ids in metadata so a webhook can always find the order", async () => {
    const body = svc().buildDeliveryBody(order(), estimate, null);
    expect(body.metadata).toMatchObject({
      orderId: "clorderid00000000",
      locationId: "loc1",
      tenantId: "t1",
    });
  });

  it("books against the estimate's requestId", async () => {
    expect(svc().buildDeliveryBody(order(), estimate, null).requestId).toBe("req-1");
  });
});
