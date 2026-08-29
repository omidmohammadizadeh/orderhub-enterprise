import { DispatchService } from "../dispatch.service";

// Third-party riders on the dispatch map.
//
// Only some providers send a position at all: Deliveroo puts lat/lon on every
// rider event, Uber Direct and Stuart send one on their own webhooks. Uber
// Eats marketplace, Just Eat and HubRise-relayed orders send NO coordinates,
// so those couriers can never be plotted however the UI is written.
//
// What these tests pin down is the honesty of the pin: a position without a
// fresh timestamp must not be drawn, because an operator will believe it.

function svcWith(orders: any[]) {
  const svc: any = Object.create(DispatchService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.locationGeoCache = new Map();
  svc.geocoder = { geocode: jest.fn().mockResolvedValue(null) };
  svc.prisma = {
    location: { findMany: jest.fn().mockResolvedValue([]) },
    order: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(orders) // live
        .mockResolvedValueOnce([]), // recently done
      update: jest.fn().mockResolvedValue({}),
    },
    driverPresence: { findMany: jest.fn().mockResolvedValue([]) },
    userLocation: { findMany: jest.fn().mockResolvedValue([]) },
    userBrand: { findMany: jest.fn().mockResolvedValue([]) },
  };
  svc.resolveAccessibleLocationIds = jest.fn().mockResolvedValue(["loc-1"]);
  return svc as DispatchService & any;
}

const baseOrder = (over: Record<string, any> = {}) => ({
  id: "o1",
  displayId: "#4509",
  orderNumber: 4509,
  status: "OUT_FOR_DELIVERY",
  platform: "DELIVEROO",
  deliveryType: "PLATFORM",
  locationId: "loc-1",
  customerName: "Lee M.",
  total: { toString: () => "33.83" },
  paymentMethod: "CARD",
  deliveryLat: 54.9,
  deliveryLng: -1.6,
  addressLine1: "14 Kielder Grove",
  city: "Southampton",
  postcode: "PO130ZA",
  deliveryAddress: null,
  scheduledFor: null,
  estimatedReadyAt: null,
  preparationMinutes: 20,
  createdAt: new Date(),
  courierName: "Deliveroo Rider",
  courierPhone: "442033195035",
  courierStatus: "rider_in_transit",
  ...over,
});

const user: any = { userId: "u1", tenantId: "t1", role: "PLATFORM_ADMIN" };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("dispatch feed — third-party couriers", () => {
  it("plots a rider the provider is actively reporting", async () => {
    const svc = svcWith([
      baseOrder({
        courierLat: 54.95,
        courierLng: -1.62,
        courierLocationAt: minutesAgo(1),
      }),
    ]);
    const feed = await svc.getFeed(user, "loc-1");
    expect(feed.couriers).toHaveLength(1);
    expect(feed.couriers[0]).toMatchObject({
      orderId: "o1",
      platform: "DELIVEROO",
      name: "Deliveroo Rider",
      ref: "#4509",
    });
  });

  it("drops a rider who stopped reporting — a frozen pin is worse than none", async () => {
    const svc = svcWith([
      baseOrder({
        courierLat: 54.95,
        courierLng: -1.62,
        courierLocationAt: minutesAgo(40),
      }),
    ]);
    const feed = await svc.getFeed(user, "loc-1");
    expect(feed.couriers).toEqual([]);
  });

  it("says nothing about a provider that sends no position (Just Eat, Uber Eats)", async () => {
    const svc = svcWith([
      baseOrder({
        platform: "JUST_EAT",
        courierLat: null,
        courierLng: null,
        courierLocationAt: null,
      }),
    ]);
    const feed = await svc.getFeed(user, "loc-1");
    expect(feed.couriers).toEqual([]);
    // The ORDER is still on the map — only the rider is unknown.
    expect(feed.orders).toHaveLength(1);
    expect(feed.orders[0].lat).toBe(54.9);
  });

  it("carries the age so the map can fade an ageing fix", async () => {
    const svc = svcWith([
      baseOrder({
        courierLat: 54.95,
        courierLng: -1.62,
        courierLocationAt: minutesAgo(6),
      }),
    ]);
    const feed = await svc.getFeed(user, "loc-1");
    expect(feed.couriers[0].ageMinutes).toBe(6);
  });
});
