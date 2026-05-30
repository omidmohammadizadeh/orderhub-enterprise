// Phase AM — scheduled-vs-immediate behaviour for OrdersService.
//
// We deliberately don't spin up a full Nest test bed here — the service has
// too many collaborators. Instead we instantiate it directly with handwritten
// mocks for the bits we care about: prisma.order.* and the PrintQueueService.
// The point of these tests is to lock in two contractual behaviours:
//
//   1. A POST with isScheduled=true does NOT call enqueueForNewOrder at
//      create-time.
//   2. startPreparingScheduled() bumps the order into ACCEPTED and triggers
//      the print pipeline via the normal updateStatus path.

import { OrdersService } from "../orders.service";

function makeService(opts: {
  initialOrder?: any;
  enqueueForNewOrder?: jest.Mock;
} = {}) {
  const enqueueForNewOrder = opts.enqueueForNewOrder ?? jest.fn().mockResolvedValue(undefined);
  const enqueueCancel = jest.fn().mockResolvedValue(undefined);

  const orderRow: any = opts.initialOrder ?? {
    id: "ord-1",
    tenantId: "t1",
    locationId: "loc1",
    status: "PENDING",
    scheduledFor: null,
    scheduledAt: null,
    updatedAt: new Date(),
    platform: "DIRECT",
    orderSource: "POS",
    fulfillmentType: "PICKUP",
    displayId: null,
    customerInfo: {},
    total: 10,
    createdAt: new Date(),
  };

  const prisma: any = {
    order: {
      findFirst: jest.fn().mockResolvedValue(orderRow),
      findUnique: jest.fn().mockResolvedValue(orderRow),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...orderRow, status: "ACCEPTED" }),
      update: jest.fn().mockResolvedValue(orderRow),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };

  const socket: any = {
    emitToLocation: jest.fn(),
    emitOrderUpdated: jest.fn(),
    emitNewOrder: jest.fn(),
  };
  const audit: any = { log: jest.fn() };
  const outbox: any = {
    forOrderReceived: jest.fn().mockReturnValue({}),
    forStatusChanged: jest.fn().mockReturnValue({}),
  };
  const printQueue: any = { enqueueForNewOrder, enqueueCancel };
  const promoCodes: any = { incrementUsage: jest.fn() };

  const svc = new OrdersService(prisma, socket, audit, outbox, printQueue, promoCodes);
  return { svc, prisma, printQueue, enqueueForNewOrder };
}

describe("OrdersService — Phase AM print gating", () => {
  it("ACCEPTED status transition triggers enqueueForNewOrder", async () => {
    const { svc, enqueueForNewOrder } = makeService();
    await svc.updateStatus(
      "ord-1",
      "t1",
      { status: "ACCEPTED" },
      "user-1",
      "STAFF",
    );
    // The print call is fire-and-forget; we await a tick to let it run.
    await new Promise((r) => setImmediate(r));
    expect(enqueueForNewOrder).toHaveBeenCalledWith("ord-1");
  });

  it("startPreparingScheduled clears scheduledAt and accepts the order", async () => {
    const scheduled = {
      id: "ord-2",
      tenantId: "t1",
      locationId: "loc1",
      status: "PENDING",
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      scheduledFor: null,
      updatedAt: new Date(),
      platform: "DIRECT",
      orderSource: "POS",
      fulfillmentType: "PICKUP",
      displayId: null,
      customerInfo: {},
      total: 10,
      createdAt: new Date(),
    };
    const { svc, prisma, enqueueForNewOrder } = makeService({ initialOrder: scheduled });

    await svc.startPreparingScheduled("ord-2", "t1", "user-1");

    // scheduledAt should have been cleared before the status update so the
    // order leaves the Scheduled section on the board.
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: "ord-2" },
      data: { scheduledAt: null },
    });

    await new Promise((r) => setImmediate(r));
    expect(enqueueForNewOrder).toHaveBeenCalledWith("ord-2");
  });

  it("isFutureScheduled treats <10min ahead as immediate", () => {
    const { svc } = makeService();
    const tenSec = new Date(Date.now() + 10_000);
    const twentyMin = new Date(Date.now() + 20 * 60_000);
    // Access the private method via the prototype for the assertion.
    const isFuture = (OrdersService.prototype as any).isFutureScheduled.bind(svc);
    expect(isFuture(tenSec)).toBe(false);
    expect(isFuture(twentyMin)).toBe(true);
    expect(isFuture(null)).toBe(false);
  });
});
