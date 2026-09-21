import { DispatchService } from "../dispatch.service";

// The Map button on the orders board — one order's geography.
//
// Two things matter beyond "it returns pins". Scoping: a tenant match is not
// enough, because a manager must not be able to open an order belonging to a
// shop they have no access to. And rider honesty: the pin has to mean "they
// are there", which is why a third-party position that stopped updating is
// dropped rather than drawn — the same rule the dispatch map feed applies.

const MINUTES = 60_000;

function svcWith(opts: {
  order?: any;
  accessible?: string[];
  assignment?: any;
}) {
  const order =
    opts.order === undefined
      ? {
          id: "o1",
          displayId: "#4509",
          orderNumber: 4509,
          status: "OUT_FOR_DELIVERY",
          customerName: "Lee M.",
          locationId: "loc-1",
          deliveryLat: 54.97,
          deliveryLng: -1.61,
          deliveryAddress: null,
          addressLine1: "10 Grainger Street",
          city: "Newcastle upon Tyne",
          postcode: "NE1 5JQ",
          courierLat: null,
          courierLng: null,
          courierLocationAt: null,
          courierName: null,
          location: {
            id: "loc-1",
            name: "Pizza Uno",
            addressLine1: "1 High Street",
            city: "Newcastle upon Tyne",
            postcode: "NE1 1AA",
            country: "GB",
          },
        }
      : opts.order;

  const svc: any = Object.create(DispatchService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.locationGeoCache = new Map([["loc-1", { lat: 54.9, lng: -1.6 }]]);
  svc.geocoder = { geocode: jest.fn().mockResolvedValue(null) };
  svc.prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({}),
    },
    driverAssignment: {
      findFirst: jest.fn().mockResolvedValue(opts.assignment ?? null),
    },
  };
  svc.resolveAccessibleLocationIds = jest
    .fn()
    .mockResolvedValue(opts.accessible ?? ["loc-1"]);
  return svc as DispatchService & any;
}

const user: any = { userId: "u1", tenantId: "t1", role: "MANAGER" };

describe("getOrderMap", () => {
  it("returns the shop and the delivery point", async () => {
    const svc = svcWith({});

    const view = await svc.getOrderMap(user, "o1");

    expect(view.order).toMatchObject({ ref: "#4509", lat: 54.97, lng: -1.61 });
    expect(view.order.address).toContain("10 Grainger Street");
    expect(view.shop).toMatchObject({ name: "Pizza Uno", lat: 54.9, lng: -1.6 });
    expect(view.rider).toBeNull();
  });

  it("refuses an order in a shop the user cannot access", async () => {
    const svc = svcWith({ accessible: ["loc-2"] });

    await expect(svc.getOrderMap(user, "o1")).rejects.toThrow(
      /not in one of your locations/i,
    );
  });

  it("404s an order outside the tenant", async () => {
    const svc = svcWith({ order: null });

    await expect(svc.getOrderMap(user, "o1")).rejects.toThrow(/not found/i);
  });

  it("draws our own driver from their live assignment", async () => {
    const svc = svcWith({
      assignment: {
        driver: {
          firstName: "Sam",
          lastName: "Okafor",
          presence: {
            lat: 54.95,
            lng: -1.62,
            lastPingAt: new Date(Date.now() - 2 * MINUTES),
          },
        },
      },
    });

    const view = await svc.getOrderMap(user, "o1");

    expect(view.rider).toMatchObject({
      kind: "DRIVER",
      name: "Sam Okafor",
      lat: 54.95,
      ageMinutes: 2,
    });
  });

  const withCourierSeen = (minutesAgo: number) => ({
    id: "o1",
    displayId: "#4509",
    orderNumber: 4509,
    status: "OUT_FOR_DELIVERY",
    customerName: "Lee M.",
    locationId: "loc-1",
    deliveryLat: 54.97,
    deliveryLng: -1.61,
    deliveryAddress: null,
    addressLine1: "10 Grainger Street",
    city: "Newcastle upon Tyne",
    postcode: "NE1 5JQ",
    courierLat: 54.96,
    courierLng: -1.6,
    courierLocationAt: new Date(Date.now() - minutesAgo * MINUTES),
    courierName: "Stuart rider",
    location: {
      id: "loc-1",
      name: "Pizza Uno",
      addressLine1: "1 High Street",
      city: "Newcastle upon Tyne",
      postcode: "NE1 1AA",
      country: "GB",
    },
  });

  it("draws a third-party rider when there is no own driver", async () => {
    const svc = svcWith({ order: withCourierSeen(3) });

    const view = await svc.getOrderMap(user, "o1");

    expect(view.rider).toMatchObject({
      kind: "COURIER",
      name: "Stuart rider",
      ageMinutes: 3,
    });
  });

  it("drops a third-party position that stopped updating", async () => {
    // 20 minutes old — past the 15-minute rule the map feed uses.
    const svc = svcWith({ order: withCourierSeen(20) });

    const view = await svc.getOrderMap(user, "o1");

    // No pin at all rather than one the operator would believe.
    expect(view.rider).toBeNull();
  });

  it("prefers our own driver over a third-party position on the same order", async () => {
    const svc = svcWith({
      order: withCourierSeen(3),
      assignment: {
        driver: {
          firstName: "Sam",
          lastName: "Okafor",
          presence: {
            lat: 54.95,
            lng: -1.62,
            lastPingAt: new Date(Date.now() - 1 * MINUTES),
          },
        },
      },
    });

    const view = await svc.getOrderMap(user, "o1");

    expect(view.rider?.kind).toBe("DRIVER");
  });
});
