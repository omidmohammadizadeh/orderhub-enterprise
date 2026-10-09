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
//   3. A prepaid round never leaves a table looking busy, and never frees
//      one a human seated. The guest is owed a bill, and gets one.

const TENANT = "t1";

function makeService(opts: {
  qrPayment?: string;
  country?: string;
  connect?: { id: string | null; stripeAccountId: string } | null;
  table?: Record<string, unknown>;
  tapConfigured?: boolean;
  tapMerchantId?: string | null;
  /** Present = order.findFirst resolves, for the post-payment listener. */
  order?: Record<string, unknown>;
} = {}) {
  const tableUpdates: any[] = [];
  const tableUpdateManys: any[] = [];
  const createdOrders: any[] = [];
  const orderUpdates: any[] = [];
  const customerUpserts: any[] = [];
  const intents: any[] = [];
  const tapCharges: any[] = [];
  const reconciled: string[] = [];
  const receipts: any[] = [];

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
      updateMany: async (args: any) => {
        tableUpdateManys.push(args);
        // Mirror what Postgres does: the row only matches when every
        // condition in the WHERE holds.
        const matches = Object.entries(args.where ?? {}).every(
          ([k, v]) => (table as any)[k] === v,
        );
        return { count: matches ? 1 : 0 };
      },
    },
    order: {
      findMany: async () => [],
      findFirst: async () =>
        opts.order === undefined
          ? null
          : {
              id: "ord1",
              tableId: "tbl1",
              paymentMethod: "QR_CODE",
              paymentStatus: "PAID",
              customerInfo: { name: "Omid", email: "omid@example.com" },
              metadata: {},
              ...opts.order,
            },
      findUnique: async () => null,
      update: async (args: any) => {
        orderUpdates.push(args);
        return { id: "ord1" };
      },
    },
    customer: {
      upsert: async (args: any) => {
        customerUpserts.push(args);
        return { id: "cus1", firstName: args.create?.firstName ?? null };
      },
      update: async () => ({ id: "cus1" }),
    },
    brand: {
      findFirst: async () => ({
        id: "b1",
        tapMerchantId: opts.tapMerchantId === undefined ? "merchant_shop" : opts.tapMerchantId,
      }),
    },
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
    reconcileOrderPayment: async (id: string) => {
      reconciled.push(`stripe:${id}`);
    },
  };

  const tap: any = {
    configured: () => opts.tapConfigured ?? true,
    createCharge: async (p: any) => {
      tapCharges.push(p);
      return { chargeId: "chg_1", redirectUrl: "https://checkout.tap.company/x", amount: 14, currency: "AED" };
    },
    reconcileOrder: async (id: string) => {
      reconciled.push(`tap:${id}`);
    },
  };

  const receiptEmail: any = {
    sendOrderReceipt: async (args: any) => {
      receipts.push(args);
      return { sent: true };
    },
  };

  const svc = new TableQrService(prisma, orders, payments, tap, receiptEmail);
  return {
    svc,
    tableUpdates,
    tableUpdateManys,
    createdOrders,
    orderUpdates,
    customerUpserts,
    intents,
    tapCharges,
    reconciled,
    receipts,
    table,
  };
}

const LINES = [{ name: "Margherita", quantity: 1, unitPrice: 12, totalPrice: 12 }];

/** A pay-now basket, with the contact details this route now requires. */
const BASKET = {
  items: LINES,
  customerName: "Omid Mohammadizadeh",
  customerEmail: "Omid@Example.com",
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
    // The marker that keeps it off the board and out of history until the
    // card clears, like an online card order. A staff QR/payment link has no
    // such marker and stays in "Waiting for payment" where staff want it.
    expect(dto.guestPrepay).toBe(true);

    expect(intents).toEqual([{ tenantId: TENANT, orderId: "ord1" }]);
    expect(res.clientSecret).toBe("cs_test_1");
    expect(res.stripeAccountId).toBe("acct_shop");
    // The guest is quoted what Stripe will actually take, not the basket.
    expect(res.amountPence).toBe(1400);
    expect(res.subtotal).toBe(12);
    expect(res.serviceCharge).toBe(2);
  });

  it("leaves the table alone — a prepaid round opens no tab", async () => {
    const { svc, tableUpdates } = makeService({ qrPayment: "PAY_NOW" });
    await svc.checkout("tok", BASKET);

    // This used to mark the table OCCUPIED, which reads on the floor plan
    // as "there's a bill running here" and never cleared, because a prepaid
    // ticket has no settle step to clear it.
    expect(tableUpdates).toHaveLength(0);
  });

  it("takes a name and an email, whoever takes the card", async () => {
    // Tap has always needed the email. Stripe doesn't — but the guest does:
    // they are paying in full, and an emailed bill is the only receipt a
    // phone can be handed.
    for (const country of ["GB", "AE"]) {
      const { svc, createdOrders } = makeService({
        qrPayment: "PAY_NOW",
        country,
      });

      await expect(
        svc.checkout("tok", { items: LINES, customerEmail: "a@b.co" }),
      ).rejects.toThrow(/enter your name/i);
      await expect(
        svc.checkout("tok", { items: LINES, customerName: "Omid" }),
      ).rejects.toThrow(/email address/i);
      await expect(
        svc.checkout("tok", { ...BASKET, customerEmail: "not-an-email" }),
      ).rejects.toThrow(/email address/i);
      // Nothing is written for a basket we are going to refuse.
      expect(createdOrders).toHaveLength(0);

      await svc.checkout("tok", BASKET);
      // Lower-cased on the way in, and in customerInfo because Order has no
      // email column — which is also where the receipt reads it from.
      expect(createdOrders[0].customerInfo).toEqual({
        name: "Omid Mohammadizadeh",
        email: "omid@example.com",
      });
    }
  });

  it("puts the guest in the restaurant's customer list and links the order", async () => {
    const { svc, customerUpserts, orderUpdates } = makeService({
      qrPayment: "PAY_NOW",
    });
    await svc.checkout("tok", BASKET);

    expect(customerUpserts).toHaveLength(1);
    const up = customerUpserts[0];
    expect(up.where).toEqual({
      tenantId_email: { tenantId: TENANT, email: "omid@example.com" },
    });
    expect(up.create).toMatchObject({
      tenantId: TENANT,
      email: "omid@example.com",
      firstName: "Omid",
      lastName: "Mohammadizadeh",
    });
    // The address was given so a bill could be sent. That is not permission
    // to market to it, so consent is left at its `false` default.
    expect(up.create).not.toHaveProperty("marketingConsent");
    // An existing customer is never overwritten by what was typed into a
    // phone tonight — a name the shop curated wins.
    expect(up.update).toEqual({});
    expect(orderUpdates).toContainEqual(
      expect.objectContaining({ data: { customerId: "cus1" } }),
    );
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

  it("sends a Tap shop's guest to Tap's hosted page, on a TAP-flagged unpaid order", async () => {
    const { svc, createdOrders, intents, tapCharges } = makeService({
      qrPayment: "PAY_NOW",
      country: "AE",
    });
    process.env.WEB_URL = "https://web.example";
    const res = await svc.checkout("tok", {
      ...BASKET,
      customerName: "Omar Ali",
      customerEmail: "omar@example.com",
    });
    delete process.env.WEB_URL;

    expect(createdOrders).toHaveLength(1);
    expect(createdOrders[0]).toMatchObject({
      paymentMethod: "QR_CODE",
      paymentStatus: "PENDING",
      paymentProvider: "TAP",
    });
    // No Stripe intent is ever minted for a Gulf shop.
    expect(intents).toHaveLength(0);
    expect(tapCharges).toHaveLength(1);
    expect(tapCharges[0]).toMatchObject({
      tenantId: TENANT,
      orderId: "ord1",
      // Back to the same landing a 3-D Secure redirect uses.
      redirectUrl: "https://web.example/t/tok?paid=ord1",
      customer: { firstName: "Omar", lastName: "Ali", email: "omar@example.com" },
    });
    expect(res.checkoutUrl).toBe("https://checkout.tap.company/x");
    expect(res.clientSecret).toBeUndefined();
  });

  it("refuses before writing anything when the brand has no Tap merchant yet", async () => {
    const { svc, createdOrders } = makeService({
      qrPayment: "PAY_NOW",
      country: "AE",
      tapMerchantId: null,
    });
    await expect(
      svc.checkout("tok", { ...BASKET, customerEmail: "a@b.co" }),
    ).rejects.toThrow(/hasn't finished setting up card payments/i);
    expect(createdOrders).toHaveLength(0);
  });

  it("refuses before writing anything when Tap isn't configured at all", async () => {
    const { svc, createdOrders } = makeService({
      qrPayment: "PAY_NOW",
      country: "AE",
      tapConfigured: false,
    });
    await expect(
      svc.checkout("tok", { ...BASKET, customerEmail: "a@b.co" }),
    ).rejects.toThrow(/hasn't finished setting up card payments/i);
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

describe("orderStatus", () => {
  it("reconciles a pending order with whichever provider took the card", async () => {
    const pending = { id: "ord1", tableId: "tbl1", paymentStatus: "PENDING", total: 14, status: "PENDING" };
    for (const [country, expected] of [["AE", "tap:ord1"], ["GB", "stripe:ord1"]] as const) {
      const { svc, reconciled } = makeService({ qrPayment: "PAY_NOW", country });
      (svc as any).prisma.order.findFirst = async () => ({ ...pending });
      await svc.orderStatus("tok", "ord1");
      expect(reconciled).toEqual([expected]);
    }
  });
});

describe("when the money lands", () => {
  const PAID = { orderId: "ord1", tenantId: TENANT, locationId: "loc1" };

  it("frees a table this flow left occupied — there is no bill to collect", async () => {
    const { svc, tableUpdateManys } = makeService({
      qrPayment: "PAY_NOW",
      order: {},
      table: { status: "OCCUPIED" },
    });
    await svc.onPaymentAuthorized(PAID);

    expect(tableUpdateManys).toHaveLength(1);
    const call = tableUpdateManys[0];
    expect(call.data).toEqual({ status: "FREE", openedAt: null });
    // Every condition is a reason to leave the table alone, and they live
    // in the WHERE rather than a read-then-write, so two guests paying in
    // the same second can't both decide the table is theirs to clear.
    expect(call.where).toEqual({
      id: "tbl1",
      status: "OCCUPIED",
      currentOrderId: null,
      serverId: null,
      serverName: null,
      covers: null,
    });
  });

  it("never frees a table a waiter has a real tab on", async () => {
    const { svc, tableUpdateManys } = makeService({
      qrPayment: "PAY_NOW",
      order: {},
      table: { status: "OCCUPIED", currentOrderId: "ord-waiter-tab" },
    });
    await svc.onPaymentAuthorized(PAID);
    // The update still runs; the WHERE no longer matches. That is the
    // point — the database decides, not a race-prone read.
    expect(tableUpdateManys[0].where.currentOrderId).toBeNull();
  });

  it("emails the itemised bill to the address the guest gave", async () => {
    const { svc, receipts, orderUpdates } = makeService({
      qrPayment: "PAY_NOW",
      order: {},
    });
    await svc.onPaymentAuthorized(PAID);

    expect(receipts).toEqual([
      { tenantId: TENANT, orderId: "ord1", to: "omid@example.com" },
    ]);
    // Marked AFTER sending: a duplicate receipt is a far smaller problem
    // than a guest who paid and never got one.
    expect(orderUpdates.at(-1).data.metadata.tableQrReceiptEmailedAt).toEqual(
      expect.any(String),
    );
  });

  it("doesn't send the bill twice when the webhook and the poll race", async () => {
    const { svc, receipts } = makeService({
      qrPayment: "PAY_NOW",
      order: { metadata: { tableQrReceiptEmailedAt: "2026-10-08T12:00:00Z" } },
    });
    await svc.onPaymentAuthorized(PAID);
    expect(receipts).toHaveLength(0);
  });

  it("ignores every payment that isn't a prepaid table round", async () => {
    // This listener sees every payment the platform collects, so the
    // scoping is the whole safety story.
    for (const order of [
      { tableId: null },
      { paymentMethod: "CARD" },
      { paymentStatus: "PENDING" },
    ]) {
      const { svc, tableUpdateManys, receipts } = makeService({
        qrPayment: "PAY_NOW",
        order,
        table: { status: "OCCUPIED" },
      });
      await svc.onPaymentAuthorized(PAID);
      expect(tableUpdateManys).toHaveLength(0);
      expect(receipts).toHaveLength(0);
    }
  });

  it("never lets a failed receipt stop the order", async () => {
    const { svc } = makeService({ qrPayment: "PAY_NOW", order: {} });
    (svc as any).receipts.sendOrderReceipt = async () => {
      throw new Error("Resend is down");
    };
    await expect(svc.onPaymentAuthorized(PAID)).resolves.toBeUndefined();
  });
});

describe("resolve", () => {
  it("tells the phone who takes the card", async () => {
    await expect(makeService({ country: "AE" }).svc.resolve("tok")).resolves.toMatchObject({
      cardProvider: "TAP",
    });
    await expect(makeService().svc.resolve("tok")).resolves.toMatchObject({
      cardProvider: "STRIPE",
    });
  });

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
