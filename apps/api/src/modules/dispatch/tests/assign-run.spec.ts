import { DispatchService } from "../dispatch.service";

// Own-fleet run: several orders to one driver, stops in the order picked.
//
// The dispatch map could only ever offer eligible pins, so this used to trust
// its input — it wrote as it went and skipped anything it couldn't find. The
// orders board now sends it arbitrary selections (bulk dispatch), so it must
// refuse a bad pick outright and name it, before writing any of the run.

const manager: any = { userId: "u1", tenantId: "t1", role: "MANAGER" };

const order = (id: string, over: Record<string, any> = {}) => ({
  id,
  displayId: `#${id.toUpperCase()}`,
  orderNumber: null,
  status: "READY",
  locationId: "loc-1",
  fulfillmentType: "DELIVERY",
  deliveryType: null,
  courierJobId: null,
  ...over,
});

function svcWith(orders: any[], accessible: string[] = ["loc-1"]) {
  const upserts: any[] = [];
  const orderUpdates: any[] = [];
  const tx = {
    driverAssignment: {
      upsert: jest.fn(async (args: any) => {
        upserts.push(args);
        return { id: `a-${args.where.orderId}` };
      }),
    },
    order: {
      update: jest.fn(async (args: any) => {
        orderUpdates.push(args);
        return {};
      }),
    },
  };
  const prisma: any = {
    driver: { findFirst: jest.fn(async () => ({ id: "d1" })) },
    order: {
      findMany: jest.fn(async ({ where }: any) =>
        orders.filter((o) => where.id.in.includes(o.id)),
      ),
    },
    driverPresence: {
      findUnique: jest.fn(async () => ({ pushToken: "tok" })),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const s: any = Object.create(DispatchService.prototype);
  s.prisma = prisma;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.expoPush = { sendNewJob: jest.fn().mockResolvedValue(undefined) };
  s.resolveAccessibleLocationIds = jest.fn().mockResolvedValue(accessible);
  return { s: s as DispatchService, upserts, orderUpdates, prisma };
}

describe("assignToDriver (own-fleet run)", () => {
  it("numbers the stops in the order they were picked", async () => {
    const { s, upserts } = svcWith([order("a"), order("b"), order("c")]);

    await s.assignToDriver(manager, "d1", ["c", "a", "b"]);

    expect(upserts.map((u) => [u.where.orderId, u.create.sequence])).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
  });

  it("writes the whole run in one transaction", async () => {
    const { s, prisma, orderUpdates } = svcWith([order("a"), order("b")]);

    await s.assignToDriver(manager, "d1", ["a", "b"]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(orderUpdates).toHaveLength(2);
  });

  it("refuses an order already on a Stuart courier and writes nothing", async () => {
    const { s, upserts } = svcWith([order("a"), order("b", { courierJobId: "555" })]);

    await expect(s.assignToDriver(manager, "d1", ["a", "b"])).rejects.toThrow(
      /#B is already on a courier/,
    );
    expect(upserts).toHaveLength(0);
  });

  it("refuses an order from a shop the user can't access", async () => {
    const { s } = svcWith([order("a", { locationId: "loc-2" })]);

    await expect(s.assignToDriver(manager, "d1", ["a"])).rejects.toThrow(
      /isn't in one of your locations/,
    );
  });

  it("refuses a marketplace-rider order, a collection, and a finished order", async () => {
    await expect(
      svcWith([order("a", { deliveryType: "PLATFORM" })]).s.assignToDriver(manager, "d1", ["a"]),
    ).rejects.toThrow(/marketplace's own rider/);
    await expect(
      svcWith([order("a", { fulfillmentType: "PICKUP" })]).s.assignToDriver(manager, "d1", ["a"]),
    ).rejects.toThrow(/isn't a delivery/);
    await expect(
      svcWith([order("a", { status: "COMPLETED" })]).s.assignToDriver(manager, "d1", ["a"]),
    ).rejects.toThrow(/only accepted, preparing or ready/);
  });

  it("still accepts a pending-dispatch order, which the dispatch map can select", async () => {
    const { s, upserts } = svcWith([order("a", { status: "PENDING_DISPATCH" })]);

    await s.assignToDriver(manager, "d1", ["a"]);

    expect(upserts).toHaveLength(1);
  });

  it("refuses the run when an order has disappeared, instead of quietly skipping it", async () => {
    const { s, upserts } = svcWith([order("a")]);

    await expect(s.assignToDriver(manager, "d1", ["a", "gone"])).rejects.toThrow(
      /no longer exists/,
    );
    expect(upserts).toHaveLength(0);
  });
});
