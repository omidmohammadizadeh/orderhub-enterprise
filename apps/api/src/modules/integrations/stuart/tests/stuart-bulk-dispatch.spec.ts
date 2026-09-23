import { StuartDispatchService } from "../stuart-dispatch.service";

// Several orders on one Stuart courier (a multi-drop run).
//
// Three things here involve money or a customer's food, so they are pinned:
//   • nothing is charged or booked unless the whole run is valid — a bad pick
//     must not leave half a run dispatched;
//   • if Stuart refuses the job, every fee taken is given back;
//   • each order gets ITS OWN leg back. Stuart reorders the dropoffs into the
//     best route, so position in the response means nothing — matching by it
//     would give customer A's tracking link to customer B.

const admin: any = { userId: "u1", tenantId: "t1", role: "PLATFORM_ADMIN" };
const manager: any = { userId: "u2", tenantId: "t1", role: "MANAGER" };

const order = (id: string, over: Record<string, any> = {}) => ({
  id,
  tenantId: "t1",
  locationId: "loc-1",
  displayId: `#${id.toUpperCase()}`,
  orderNumber: null,
  status: "READY",
  fulfillmentType: "DELIVERY",
  deliveryType: null,
  courierJobId: null,
  customerName: "Lee Morgan",
  customerPhone: "+447700900001",
  deliveryAddress: { line1: `${id} Grainger Street`, city: "Newcastle", postcode: "NE1 5JQ" },
  ...over,
});

function svcWith(opts: {
  orders: any[];
  createJob?: (payload: any) => any;
  allowedLocations?: string[];
}) {
  const writes: Array<{ id: string; data: any }> = [];
  const prisma: any = {
    order: {
      findMany: jest.fn(async ({ where }: any) =>
        opts.orders.filter((o) => where.id.in.includes(o.id)),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        writes.push({ id: where.id, data });
        return {};
      }),
      count: jest.fn(),
    },
    location: {
      findUnique: jest.fn(async () => ({
        id: "loc-1",
        name: "Pizza Uno",
        addressLine1: "1 High Street",
        city: "Newcastle",
        postcode: "NE1 1AA",
      })),
    },
    // resolveOrderScope, for a non-admin
    userLocation: {
      findMany: jest.fn(async () =>
        (opts.allowedLocations ?? ["loc-1"]).map((locationId) => ({ locationId })),
      ),
    },
    userBrand: { findMany: jest.fn(async () => []) },
    brand: { findMany: jest.fn(async () => []) },
  };
  const wallet = {
    dispatchFeeMinor: jest.fn(() => 50),
    assertCanAffordDispatch: jest.fn().mockResolvedValue(undefined),
    debitForDispatch: jest.fn().mockResolvedValue({}),
    refundDispatch: jest.fn().mockResolvedValue(undefined),
  };
  const client = {
    createJob: jest.fn(async (_cfg: any, payload: any) =>
      opts.createJob ? opts.createJob(payload) : { id: 1, deliveries: [] },
    ),
    pricing: jest.fn(async () => ({ amount: 11.4, currency: "GBP" })),
    cancelJob: jest.fn(),
    cancelDelivery: jest.fn(),
  };
  const config = {
    getDecrypted: jest.fn(async () => ({ active: true, clientId: "c", clientSecret: "s", environment: "sandbox" })),
  };
  const s: any = Object.create(StuartDispatchService.prototype);
  Object.assign(s, {
    prisma,
    wallet,
    client,
    config,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { s: s as StuartDispatchService, prisma, wallet, client, writes };
}

/** A Stuart response that returns the legs in the REVERSE of the order sent. */
const reversedJob = (payload: any) => ({
  id: 555,
  status: "new",
  deliveries: [...payload.job.dropoffs].reverse().map((d: any, i: number) => ({
    id: 900 + i,
    status: "pending",
    client_reference: d.client_reference,
    tracking_url: `https://track/${d.client_reference}`,
  })),
});

describe("Stuart bulk dispatch", () => {
  it("gives each order its own leg even when Stuart reorders the route", async () => {
    const { s, writes } = svcWith({
      orders: [order("a"), order("b"), order("c")],
      createJob: reversedJob,
    });

    await s.dispatchBulk({ orderIds: ["a", "b", "c"], user: admin, isAdmin: true });

    for (const w of writes) {
      expect(w.data.courierJobId).toBe("555");
      // The tracking link was built from the client_reference sent for THIS
      // order, so it must start with this order's own ref.
      expect(w.data.courierTrackingUrl).toMatch(
        new RegExp(`^https://track/#${w.id.toUpperCase()}-`),
      );
    }
    expect(new Set(writes.map((w) => w.data.courierDeliveryId)).size).toBe(3);
  });

  it("sends one pickup and a dropoff per order, each with a unique reference", async () => {
    const { s, client } = svcWith({
      orders: [order("a"), order("b")],
      createJob: reversedJob,
    });

    await s.dispatchBulk({ orderIds: ["a", "b"], user: admin, isAdmin: true });

    const payload = client.createJob.mock.calls[0][1];
    expect(payload.job.pickups).toHaveLength(1);
    expect(payload.job.dropoffs).toHaveLength(2);
    const refs = payload.job.dropoffs.map((d: any) => d.client_reference);
    expect(new Set(refs).size).toBe(2);
  });

  it("charges the fee once per order, after checking the whole run is affordable", async () => {
    const { s, wallet } = svcWith({
      orders: [order("a"), order("b"), order("c")],
      createJob: reversedJob,
    });

    const res = await s.dispatchBulk({ orderIds: ["a", "b", "c"], user: manager, isAdmin: false });

    expect(wallet.assertCanAffordDispatch).toHaveBeenCalledWith("t1", "loc-1", 150);
    expect(wallet.debitForDispatch).toHaveBeenCalledTimes(3);
    expect(res.feeChargedMinor).toBe(150);
  });

  it("refunds every fee if Stuart refuses the run", async () => {
    const { s, wallet, writes } = svcWith({
      orders: [order("a"), order("b")],
      createJob: () => {
        throw new Error("Stuart POST /v2/jobs → 422: address out of zone");
      },
    });

    await expect(
      s.dispatchBulk({ orderIds: ["a", "b"], user: manager, isAdmin: false }),
    ).rejects.toThrow(/couldn't create the run/);

    expect(wallet.refundDispatch).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(0);
  });

  it("refunds what it took if the wallet runs dry part-way", async () => {
    const { s, wallet, client } = svcWith({
      orders: [order("a"), order("b"), order("c")],
    });
    wallet.debitForDispatch
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Dispatch wallet balance is too low."));

    await expect(
      s.dispatchBulk({ orderIds: ["a", "b", "c"], user: manager, isAdmin: false }),
    ).rejects.toThrow(/too low/);

    expect(wallet.refundDispatch).toHaveBeenCalledTimes(1);
    expect(client.createJob).not.toHaveBeenCalled();
  });

  it("refuses more than Stuart's 8 dropoffs", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `o${i}`);
    const { s, client } = svcWith({ orders: ids.map((id) => order(id)) });

    await expect(
      s.dispatchBulk({ orderIds: ids, user: admin, isAdmin: true }),
    ).rejects.toThrow(/up to 8/);
    expect(client.createJob).not.toHaveBeenCalled();
  });

  it("refuses orders from two shops — one courier collects from one", async () => {
    const { s } = svcWith({
      orders: [order("a"), order("b", { locationId: "loc-2" })],
    });

    await expect(
      s.dispatchBulk({ orderIds: ["a", "b"], user: admin, isAdmin: true }),
    ).rejects.toThrow(/one shop/);
  });

  it("names the order that is already on a courier, and charges nothing", async () => {
    const { s, wallet } = svcWith({
      orders: [order("a"), order("b", { courierJobId: "old-job" })],
    });

    await expect(
      s.dispatchBulk({ orderIds: ["a", "b"], user: manager, isAdmin: false }),
    ).rejects.toThrow(/#B is already on a courier/);
    expect(wallet.debitForDispatch).not.toHaveBeenCalled();
  });

  it("refuses a marketplace-rider order and one not yet accepted", async () => {
    const platform = svcWith({ orders: [order("a", { deliveryType: "PLATFORM" })] });
    await expect(
      platform.s.dispatchBulk({ orderIds: ["a"], user: admin, isAdmin: true }),
    ).rejects.toThrow(/marketplace's own rider/);

    const pending = svcWith({ orders: [order("a", { status: "PENDING" })] });
    await expect(
      pending.s.dispatchBulk({ orderIds: ["a"], user: admin, isAdmin: true }),
    ).rejects.toThrow(/only accepted, preparing or ready/);
  });

  it("refuses a manager dispatching another shop's orders", async () => {
    const { s } = svcWith({ orders: [order("a")], allowedLocations: ["loc-9"] });

    await expect(
      s.dispatchBulk({ orderIds: ["a"], user: manager, isAdmin: false }),
    ).rejects.toThrow(/not in one of your locations|aren't in one of your locations/);
  });

  it("quotes the whole run as one price and the fee per order", async () => {
    const { s } = svcWith({ orders: [order("a"), order("b")] });

    const q = await s.quoteBulk({ orderIds: ["a", "b"], user: admin });

    expect(q).toMatchObject({
      amount: 11.4,
      orders: 2,
      dispatchFeeEachMinor: 50,
      dispatchFeeMinor: 100,
    });
  });
});

describe("Stuart cancel on a run", () => {
  function cancelSvc(order: any, othersOnJob: number) {
    const built = svcWith({ orders: [] });
    built.prisma.order.findFirst = jest.fn(async () => order);
    built.prisma.order.count = jest.fn(async () => othersOnJob);
    return built;
  }
  const onRun = {
    id: "a",
    tenantId: "t1",
    locationId: "loc-1",
    courierProvider: "STUART",
    courierJobId: "555",
    courierDeliveryId: "901",
  };

  it("takes only this order's leg off the courier while others ride on", async () => {
    const { s, client } = cancelSvc(onRun, 2);

    await s.cancel({ orderId: "a", tenantId: "t1" });

    expect(client.cancelDelivery).toHaveBeenCalledWith(expect.anything(), "901");
    // Cancelling the job here would cancel every other customer's delivery.
    expect(client.cancelJob).not.toHaveBeenCalled();
  });

  it("cancels the job when this is the last order on it", async () => {
    const { s, client } = cancelSvc(onRun, 0);

    await s.cancel({ orderId: "a", tenantId: "t1" });

    expect(client.cancelJob).toHaveBeenCalledWith(expect.anything(), "555");
    expect(client.cancelDelivery).not.toHaveBeenCalled();
  });

  it("cancels the job for a single dispatch from before per-leg ids", async () => {
    const { s, client } = cancelSvc({ ...onRun, courierDeliveryId: null }, 0);

    await s.cancel({ orderId: "a", tenantId: "t1" });

    expect(client.cancelJob).toHaveBeenCalled();
  });
});

// Same rule as the own-fleet run: a marketplace order the SHOP delivers is a
// delivery, so a courier can carry it.
describe("Stuart bulk — merchant-delivered marketplace orders", () => {
  it("accepts a MERCHANT_DELIVERY order", async () => {
    const { s: svc } = svcWith({
      orders: [
        order("a", { fulfillmentType: "MERCHANT_DELIVERY", deliveryType: "MERCHANT" }),
      ],
    });

    await expect((svc as any).loadBulk(["a"], manager)).resolves.toBeDefined();
  });

  it("still refuses a collection order", async () => {
    const { s: svc } = svcWith({ orders: [order("a", { fulfillmentType: "PICKUP" })] });

    await expect((svc as any).loadBulk(["a"], manager)).rejects.toThrow(/isn't a delivery/);
  });
});
