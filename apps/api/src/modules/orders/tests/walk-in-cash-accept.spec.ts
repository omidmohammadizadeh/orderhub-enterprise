import { OrdersService } from "../orders.service";

// Walk-in cash: the customer is AT the counter, so the money is taken before
// the ticket is worth printing. Accepting at placement printed "CASH NOT PAID"
// the instant Place order was pressed — the kitchen copy contradicting the
// till. The order now waits, unprinted, until the cash keypad settles it.
//
// The guard and the re-fire are two halves of one mechanism. A guard on its own
// means a walk-in order sits PENDING for ever and NEVER prints, which is worse
// than the bug it fixes — so both are tested together.

function makeService(order: Record<string, unknown>) {
  const accepted: string[] = [];
  const prisma = {
    location: {
      findUnique: jest.fn(async () => ({
        settings: { autoAcceptOrders: true },
      })),
    },
    order: {
      findUnique: jest.fn(async () => order),
      findFirst: jest.fn(async () => order),
      update: jest.fn(async ({ data }: any) => ({ ...order, ...data })),
    },
  } as any;
  const svc = Object.create(OrdersService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.socket = { emitOrderUpdated: jest.fn(), emitNewOrder: jest.fn() };
  svc.updateStatus = jest.fn(async (id: string) => {
    accepted.push(id);
    return order;
  });
  return { svc, accepted, prisma };
}

const WALK_IN_CASH = {
  id: "o1",
  status: "PENDING",
  platform: "POS",
  orderSource: "POS",
  metadata: {},
  paymentMethod: "CASH",
  paymentStatus: "PENDING",
  isWalkIn: true,
  locationId: "loc-1",
  // Fields the socket broadcast in setPaymentStatus reads. Present so the
  // test exercises the real emit rather than a stubbed one.
  displayId: "#1",
  customerName: "Walk-in",
  fulfillmentType: "PICKUP",
  total: 12.6,
  scheduledFor: null,
  createdAt: new Date("2026-08-21T10:00:00Z"),
};

describe("maybeAutoAccept — walk-in cash", () => {
  it("does NOT accept an unpaid walk-in cash order", async () => {
    // Accepting is what fires the print, so this is what stops a
    // "CASH NOT PAID" ticket appearing before the money is taken.
    const { svc, accepted } = makeService(WALK_IN_CASH);
    await svc.maybeAutoAccept("o1", "t1", "loc-1");
    expect(accepted).toEqual([]);
  });

  it("accepts it once the cash is in", async () => {
    const { svc, accepted } = makeService({
      ...WALK_IN_CASH,
      paymentStatus: "PAID",
    });
    await svc.maybeAutoAccept("o1", "t1", "loc-1");
    expect(accepted).toEqual(["o1"]);
  });

  it("STILL accepts an unpaid phone COLLECTION cash order", async () => {
    // The operator was explicit that collection behaviour must not change:
    // the customer is not in the shop, so the kitchen has to start cooking.
    // isWalkIn is the only thing separating the two cases.
    const { svc, accepted } = makeService({
      ...WALK_IN_CASH,
      isWalkIn: false,
    });
    await svc.maybeAutoAccept("o1", "t1", "loc-1");
    expect(accepted).toEqual(["o1"]);
  });

  it("still accepts an unpaid walk-in on a NON-cash method", async () => {
    // Card terminal has its own guard; EXTERNAL and friends must not get
    // swept up by a guard aimed at cash.
    const { svc, accepted } = makeService({
      ...WALK_IN_CASH,
      paymentMethod: "EXTERNAL",
    });
    await svc.maybeAutoAccept("o1", "t1", "loc-1");
    expect(accepted).toEqual(["o1"]);
  });
});

describe("setPaymentStatus — re-opens the accept gate", () => {
  function settleService(order: Record<string, unknown>) {
    const { svc, prisma } = makeService(order);
    svc.maybeAutoAccept = jest.fn(async () => {});
    return { svc, prisma };
  }

  it("re-fires accept when cash lands on a pending order", async () => {
    // Without this the guard above is a trap: the order would never print.
    const { svc } = settleService(WALK_IN_CASH);
    await svc.setPaymentStatus("o1", "t1", "PAID", "CASH");
    expect(svc.maybeAutoAccept).toHaveBeenCalledWith("o1", "t1", "loc-1");
  });

  it("does not re-fire when the order has already moved on", async () => {
    // An order already ACCEPTED/PREPARING has printed; re-running the gate
    // would be a no-op at best and a duplicate ticket at worst.
    const { svc } = settleService({ ...WALK_IN_CASH, status: "PREPARING" });
    await svc.setPaymentStatus("o1", "t1", "PAID", "CASH");
    expect(svc.maybeAutoAccept).not.toHaveBeenCalled();
  });

  it("does not re-fire when payment is marked unpaid", async () => {
    const { svc } = settleService(WALK_IN_CASH);
    await svc.setPaymentStatus("o1", "t1", "PENDING", "CASH");
    expect(svc.maybeAutoAccept).not.toHaveBeenCalled();
  });
});
