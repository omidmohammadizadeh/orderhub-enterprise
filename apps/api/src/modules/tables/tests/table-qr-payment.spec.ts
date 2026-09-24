import { TableQrService, readTableQrPaymentMode } from "../table-qr.service";

// Pay-before-kitchen, at a table.
//
// The thing worth pinning here is not the happy path — it's the two rules
// that keep food and money in step:
//
//   1. A PAY_NOW shop can never send a round to the kitchen for free, and a
//      PAY_LATER shop can never be charged for one. The two routes refuse
//      each other's mode rather than falling back.
//   2. A prepaid ticket is written UNPAID, flagged QR_CODE, and is NOT
//      linked as the table's tab. Both halves matter: the flag is what the
//      ingest path reads to hold the order out of the kitchen, and linking
//      it would hand a waiter a tab that addRound refuses once it's paid.

const TENANT = "t1";

function makeService(opts: {
  qrPayment?: string;
  country?: string;
  connect?: { id: string | null; stripeAccountId: string } | null;
  table?: Record<string, unknown>;
} = {}) {
  const tableUpdates: any[] = [];
  const createdOrders: any[] = [];
  const intents: any[] = [];

  const table = {
    id: "tbl1",
    name: "Table 4",
    locationId: "loc1",
    currentOrderId: null,
    openedAt: null,
    status: "FREE",
    outOfService: false,
    covers: null,
    location: {
      id: "loc1",
      name: "Pizza Uno",
      country: opts.country ?? "GB",
      settings: {
        tableService: { enabled: true, qrPayment: opts.qrPayment ?? "PAY_LATER" },
        serviceCharge: { enabled: true, percent: 10, label: "Service" },
      },
      brand: { id: "b1", name: "Pizza Uno", slug: "pizza-uno", tenantId: TENANT },
    },
    ...opts.table,
  };

  const prisma: any = {
    table: {
      findFirst: async () => table,
      update: async (args: any) => {
        tableUpdates.push(args);
        return table;
      },
    },
    order: { findMany: async () => [], findFirst: async () => null, findUnique: async () => null },
  };

  const orders: any = {
    create: async (dto: any) => {
      createdOrders.push(dto);
      return {
        id: "ord1",
        subtotal: dto.subtotal,
        serviceCharge: 2,
        total: dto.subtotal + 2,
        paymentStatus: "PENDING",
      };
    },
    addRound: async () => ({ id: "ord1" }),
  };

  const payments: any = {
    resolveConnectAccount: async () =>
      opts.connect === undefined
        ? { id: "c1", stripeAccountId: "acct_shop" }
        : opts.connect,
    createStorefrontPaymentIntent: async (p: any) => {
      intents.push(p);
      return {
        clientSecret: "cs_test_1",
        amountPence: 1400,
        stripeAccountId: "acct_shop",
      };
    },
    reconcileOrderPayment: async () => undefined,
  };

  const svc = new TableQrService(prisma, orders, payments);
  return { svc, tableUpdates, createdOrders, intents, table };
}

const BASKET = {
  items: [
    { name: "Margherita", quantity: 1, unitPrice: 12, totalPrice: 12 },
  ],
};

describe("readTableQrPaymentMode", () => {
  it("defaults to PAY_LATER — an unset shop keeps the behaviour it had", () => {
    expect(readTableQrPaymentMode(null)).toBe("PAY_LATER");
    expect(readTableQrPaymentMode({})).toBe("PAY_LATER");
    expect(readTableQrPaymentMode({ tableService: {} })).toBe("PAY_LATER");
  });

  it("only PAY_NOW switches payment on — a typo must not start charging", () => {
    expect(
      readTableQrPaymentMode({ tableService: { qrPayment: "PAY_NOW" } }),
    ).toBe("PAY_NOW");
    expect(
      readTableQrPaymentMode({ tableService: { qrPayment: "paynow" } }),
    ).toBe("PAY_LATER");
  });
});

describe("the two modes refuse each other's route", () => {
  it("PAY_NOW refuses send-to-kitchen — otherwise the round is free", async () => {
    const { svc, createdOrders } = makeService({ qrPayment: "PAY_NOW" });
    await expect(svc.placeOrder("tok", BASKET)).rejects.toThrow(
      /takes payment before the kitchen/i,
    );
    expect(createdOrders).toHaveLength(0);
  });

  it("PAY_LATER refuses checkout — a tab table must not be charged twice", async () => {
    const { svc, createdOrders } = makeService({ qrPayment: "PAY_LATER" });
    await expect(svc.checkout("tok", BASKET)).rejects.toThrow(
      /settles at the end/i,
    );
    expect(createdOrders).toHaveLength(0);
  });
});

describe("checkout", () => {
  it("writes the order unpaid and flagged QR_CODE, then mints the intent", async () => {
    const { svc, createdOrders, intents } = makeService({ qrPayment: "PAY_NOW" });
    const res = await svc.checkout("tok", BASKET);

    expect(createdOrders).toHaveLength(1);
    const dto = createdOrders[0];
    // QR_CODE + PENDING is the pair ingestCanonical reads to keep this out
    // of the New column, off the printer and out of auto-accept.
    expect(dto.paymentMethod).toBe("QR_CODE");
    expect(dto.paymentStatus).toBe("PENDING");
    expect(dto.fulfillmentType).toBe("DINE_IN");
    expect(dto.tableId).toBe("tbl1");

    expect(intents).toEqual([{ tenantId: TENANT, orderId: "ord1" }]);
    expect(res.clientSecret).toBe("cs_test_1");
    expect(res.stripeAccountId).toBe("acct_shop");
    // The guest is quoted what Stripe will actually take, not the basket.
    expect(res.amountPence).toBe(1400);
    expect(res.subtotal).toBe(12);
    expect(res.serviceCharge).toBe(2);
  });

  it("occupies the table but never links it as the tab", async () => {
    const { svc, tableUpdates } = makeService({ qrPayment: "PAY_NOW" });
    await svc.checkout("tok", BASKET);

    expect(tableUpdates).toHaveLength(1);
    const data = tableUpdates[0].data;
    expect(data.status).toBe("OCCUPIED");
    // currentOrderId means "the open tab staff will settle". A prepaid
    // ticket is not one, and addRound refuses a PAID order — linking it
    // would break the next waiter round on that table.
    expect(data).not.toHaveProperty("currentOrderId");
  });

  it("refuses before writing anything when Stripe onboarding is unfinished", async () => {
    const { svc, createdOrders } = makeService({
      qrPayment: "PAY_NOW",
      connect: null,
    });
    await expect(svc.checkout("tok", BASKET)).rejects.toThrow(
      /hasn't finished setting up card payments/i,
    );
    // No orphan unpaid order left on the staff board.
    expect(createdOrders).toHaveLength(0);
  });

  it("refuses in Tap countries — there is no on-page wallet sheet there", async () => {
    const { svc, createdOrders } = makeService({
      qrPayment: "PAY_NOW",
      country: "AE",
    });
    await expect(svc.checkout("tok", BASKET)).rejects.toThrow(
      /isn't available at this restaurant yet/i,
    );
    expect(createdOrders).toHaveLength(0);
  });

  it("replays one requestId instead of charging a flaky phone twice", async () => {
    const { svc, createdOrders, intents } = makeService({ qrPayment: "PAY_NOW" });
    const body = { ...BASKET, requestId: "req-1" };
    const first = await svc.checkout("tok", body);
    const second = await svc.checkout("tok", body);

    expect(second).toEqual(first);
    expect(createdOrders).toHaveLength(1);
    expect(intents).toHaveLength(1);
  });
});

describe("resolve", () => {
  it("tells the phone which flow to render", async () => {
    const payNow = makeService({ qrPayment: "PAY_NOW" });
    await expect(payNow.svc.resolve("tok")).resolves.toMatchObject({
      paymentMode: "PAY_NOW",
      tableName: "Table 4",
    });

    const payLater = makeService();
    await expect(payLater.svc.resolve("tok")).resolves.toMatchObject({
      paymentMode: "PAY_LATER",
    });
  });

  it("still refuses a table the shop pulled, in either mode", async () => {
    const { svc } = makeService({
      qrPayment: "PAY_NOW",
      table: { outOfService: true },
    });
    await expect(svc.resolve("tok")).rejects.toThrow(/isn't taking orders/i);
    await expect(svc.checkout("tok", BASKET)).rejects.toThrow(
      /isn't taking orders/i,
    );
  });
});
