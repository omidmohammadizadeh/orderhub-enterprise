import {
  coordsFromDeliveryAddress,
  formatDeliveryAddress,
  resolveDeliveryAddress,
} from "../../orders/delivery-address";
import { DriverAppService } from "../driver-app.service";

// "This order has no address to navigate to."
//
// Reported from a real shop: the driver tapped Navigate on an Uber Eats order
// and got that alert, while the dashboard showed the address perfectly. Cause:
// an Order carries its address twice. The till path fills the structured
// columns; `ingestCanonical` — every marketplace and online order — writes only
// the `deliveryAddress` blob and leaves the columns null. The driver app reads
// the columns. So test orders placed at the till worked and every real
// marketplace order sent the driver out blind.

describe("resolveDeliveryAddress", () => {
  it("reads a HubRise/Uber blob when the columns are empty", () => {
    // The shape from the reported order, columns null as ingestCanonical left
    // them.
    const parts = resolveDeliveryAddress({
      addressLine1: null,
      addressLine2: null,
      city: null,
      postcode: null,
      deliveryAddress: {
        line1: "3 Darwin Crescent",
        line2: "Newcastle Upon Tyne, NE3 4TT, GB",
        city: "newcastle upon tyne",
        postcode: "ne3 4tt",
      },
    });

    expect(parts.line1).toBe("3 Darwin Crescent");
    expect(parts.postcode).toBe("ne3 4tt");
    // Both the door number and the postcode, which is what makes Google land
    // on the right door rather than the street.
    expect(formatDeliveryAddress(parts)).toContain("3 Darwin Crescent");
    expect(formatDeliveryAddress(parts)).toContain("ne3 4tt");
  });

  it.each([
    ["address1 / postal_code", { address1: "12 Kenton Road", postal_code: "NE3 1AA", town: "Newcastle" }],
    ["addressLine1 / zip", { addressLine1: "12 Kenton Road", zip: "NE3 1AA", city: "Newcastle" }],
    ["street / postcode", { street: "12 Kenton Road", postcode: "NE3 1AA", city: "Newcastle" }],
  ])("reads the %s spelling", (_name, blob) => {
    const parts = resolveDeliveryAddress({ deliveryAddress: blob });
    expect(parts.line1).toBe("12 Kenton Road");
    expect(parts.postcode).toBe("NE3 1AA");
    expect(parts.city).toBe("Newcastle");
  });

  it("keeps a flat or estate name when there is no second line", () => {
    const parts = resolveDeliveryAddress({
      deliveryAddress: { line1: "Flat 2", area: "Jesmond Vale", city: "Newcastle" },
    });
    expect(parts.line2).toBe("Jesmond Vale");
  });

  it("still reads a till order, which has columns and no blob", () => {
    const parts = resolveDeliveryAddress({
      addressLine1: "10 Grainger Street",
      addressLine2: null,
      city: "Newcastle upon Tyne",
      postcode: "NE1 5JQ",
      deliveryAddress: null,
    });
    expect(formatDeliveryAddress(parts)).toBe(
      "10 Grainger Street, Newcastle upon Tyne, NE1 5JQ",
    );
  });

  it("returns nothing for a collection order, rather than inventing a line", () => {
    const parts = resolveDeliveryAddress({ deliveryAddress: null });
    expect(formatDeliveryAddress(parts)).toBe("");
  });

  it("takes coordinates the marketplace sent, nested or not, but never 0,0", () => {
    expect(coordsFromDeliveryAddress({ lat: 54.99, lng: -1.62 })).toEqual({
      lat: 54.99,
      lng: -1.62,
    });
    expect(
      coordsFromDeliveryAddress({ coordinates: { latitude: 54.99, longitude: -1.62 } }),
    ).toEqual({ lat: 54.99, lng: -1.62 });
    expect(coordsFromDeliveryAddress({ lat: 0, lng: 0 })).toBeNull();
    expect(coordsFromDeliveryAddress(null)).toBeNull();
  });
});

describe("getMyDay address", () => {
  function svc(order: any) {
    const s: any = Object.create(DriverAppService.prototype);
    s.prisma = {
      driverAssignment: {
        findMany: jest.fn().mockResolvedValue([
          { id: "a1", status: "ASSIGNED", deliveredAt: null, order },
        ]),
      },
    };
    s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    s.resolveDriver = jest
      .fn()
      .mockResolvedValue({ id: "d1", startupFee: 0, postcodeFees: [] });
    return s as DriverAppService;
  }

  const marketplaceOrder = {
    id: "o1",
    displayId: "#BE48B",
    orderNumber: null,
    status: "READY",
    total: "24.25",
    paymentMethod: "CARD",
    customerName: "Ben R.",
    customerPhone: "+447436919151",
    customerInfo: {},
    // As ingestCanonical writes it: blob only.
    addressLine1: null,
    addressLine2: null,
    city: null,
    postcode: null,
    deliveryLat: null,
    deliveryLng: null,
    deliveryAddress: {
      line1: "3 Darwin Crescent",
      city: "newcastle upon tyne",
      postcode: "ne3 4tt",
      coordinates: { lat: 55.01, lng: -1.64 },
    },
    scheduledFor: null,
    estimatedReadyAt: null,
    preparationMinutes: null,
    createdAt: new Date(),
  };

  it("gives the driver an address for a marketplace order", async () => {
    const day = await (svc(marketplaceOrder) as any).getMyDay({ userId: "u1" });

    const o = day.active[0].order;
    expect(o.addressLine1).toBe("3 Darwin Crescent");
    expect(o.postcode).toBe("ne3 4tt");
    // The app joins these four — before the fix it joined four nulls into ""
    // and told the driver the order had no address.
    expect([o.addressLine1, o.addressLine2, o.city, o.postcode].filter(Boolean).join(", "))
      .toBe("3 Darwin Crescent, newcastle upon tyne, ne3 4tt");
  });

  it("puts the destination pin on the map from coordinates already sent", async () => {
    const day = await (svc(marketplaceOrder) as any).getMyDay({ userId: "u1" });

    expect(day.active[0].order.deliveryLat).toBe(55.01);
    expect(day.active[0].order.deliveryLng).toBe(-1.64);
  });

  it("never overwrites coordinates the order already has", async () => {
    const day = await (svc({
      ...marketplaceOrder,
      deliveryLat: 54.97,
      deliveryLng: -1.61,
    }) as any).getMyDay({ userId: "u1" });

    expect(day.active[0].order.deliveryLat).toBe(54.97);
  });
});
