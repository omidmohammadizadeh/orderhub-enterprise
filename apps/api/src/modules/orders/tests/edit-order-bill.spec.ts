import { OrdersService } from "../orders.service";

// What an amended order is worth.
//
// editOrder took the money straight from the caller: an omitted field meant
// ZERO, and the total was whatever the client said it was. Two ways that
// lost real money —
//   • an amendment about a missing drink, sent without repeating the fee,
//     wiped the delivery charge; and
//   • the till computes `subtotal - discount + deliveryFee` and knows nothing
//     about the service charge (createOrder adds that server-side) or the
//     tip, so editing a dine-in order dropped both off the bill.

const service = () => {
  const s: any = Object.create(OrdersService.prototype);
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.socket = { emitNewOrder: jest.fn(), emitOrderUpdated: jest.fn() };
  s.events = { emit: jest.fn() };
  return s;
};

const existing = (over: any = {}) => ({
  id: "o1",
  tenantId: "t1",
  locationId: "l1",
  status: "PREPARING",
  paymentMethod: "CASH",
  paymentStatus: "PENDING",
  orderSource: "POS",
  platform: "POS",
  fulfillmentType: "DELIVERY",
  subtotal: 20,
  taxAmount: 0,
  deliveryFee: 3.5,
  discount: 0,
  serviceCharge: 0,
  tipAmount: 0,
  total: 23.5,
  customerInfo: null,
  customerName: "Omid",
  customerPhone: "+447700900123",
  deliveryAddress: null,
  specialInstructions: null,
  scheduledFor: null,
  createdAt: new Date(),
  items: [
    {
      id: "row-1",
      name: "Pizza",
      quantity: 1,
      unitPrice: 20,
      totalPrice: 20,
      modifiers: [],
      notes: null,
      menuItemId: "p1",
    },
  ],
  ...over,
});

const prismaWith = (order: any) => {
  const tx = {
    orderItem: {
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      createMany: jest.fn(async () => ({})),
    },
    order: { update: jest.fn(async () => ({ ...order, items: undefined })) },
    orderStatusHistory: { create: jest.fn(async () => ({})) },
  };
  return {
    tx,
    prisma: {
      order: { findFirst: jest.fn(async () => order) },
      $transaction: async (fn: any) => fn(tx),
    },
  };
};

const items = (subtotal: number) => [
  {
    name: "Pizza",
    quantity: 1,
    unitPrice: subtotal,
    totalPrice: subtotal,
    modifiers: [],
    menuItemId: "p1",
  },
];

async function edit(order: any, dto: any) {
  const s = service();
  const { prisma, tx } = prismaWith(order);
  s.prisma = prisma;
  await s.editOrder("o1", "t1", dto, "user-1");
  return {
    data: tx.order.update.mock.calls[0][0].data,
    note: tx.orderStatusHistory.create.mock.calls[0][0].data.note,
    warn: s.logger.warn,
  };
}

describe("editOrder: the bill", () => {
  it("keeps the delivery fee when the edit doesn't mention it", async () => {
    // The amendment was about a drink. It must not cost the shop £3.50.
    const { data } = await edit(existing(), {
      items: items(25),
      subtotal: 25,
      total: 25,
    });
    expect(Number(data.deliveryFee)).toBe(3.5);
    expect(Number(data.total)).toBe(28.5);
  });

  it("takes a new fee when the edit does give one", async () => {
    // Moving the order to a further postcode re-prices it; the caller still
    // decides the fee, because zone rules live in the browser with the POS.
    const { data } = await edit(existing(), {
      items: items(20),
      subtotal: 20,
      deliveryFee: 5,
      total: 25,
    });
    expect(Number(data.deliveryFee)).toBe(5);
    expect(Number(data.total)).toBe(25);
  });

  it("can still zero a fee explicitly", async () => {
    const { data } = await edit(existing(), {
      items: items(20),
      subtotal: 20,
      deliveryFee: 0,
      total: 20,
    });
    expect(Number(data.deliveryFee)).toBe(0);
    expect(Number(data.total)).toBe(20);
  });

  it("keeps a discount the edit doesn't mention", async () => {
    const { data } = await edit(existing({ discount: 5, total: 18.5 }), {
      items: items(20),
      subtotal: 20,
      total: 20,
    });
    expect(Number(data.discount)).toBe(5);
    expect(Number(data.total)).toBe(18.5);
  });

  it("keeps tax the edit doesn't mention", async () => {
    const { data } = await edit(existing({ taxAmount: 2, total: 25.5 }), {
      items: items(20),
      subtotal: 20,
      total: 20,
    });
    expect(Number(data.taxAmount)).toBe(2);
    expect(Number(data.total)).toBe(25.5);
  });

  it("keeps the service charge on the bill", async () => {
    // The till's total has never included it — createOrder adds it
    // server-side — so trusting the client's total removed it.
    const { data } = await edit(
      existing({ serviceCharge: 2.4, deliveryFee: 0, total: 22.4 }),
      { items: items(20), subtotal: 20, total: 20 },
    );
    expect(Number(data.total)).toBe(22.4);
  });

  it("charges the service charge once, however many times it's edited", async () => {
    const order = existing({ serviceCharge: 2.4, deliveryFee: 0, total: 22.4 });
    const first = await edit(order, {
      items: items(20),
      subtotal: 20,
      total: 20,
    });
    expect(Number(first.data.total)).toBe(22.4);
    // Second edit against an order already carrying that total.
    const second = await edit(
      existing({ serviceCharge: 2.4, deliveryFee: 0, total: 22.4 }),
      { items: items(30), subtotal: 30, total: 30 },
    );
    expect(Number(second.data.total)).toBe(32.4);
  });

  it("keeps a tip the customer already left", async () => {
    const { data } = await edit(
      existing({ tipAmount: 2, deliveryFee: 0, total: 22 }),
      { items: items(20), subtotal: 20, total: 20 },
    );
    expect(Number(data.tipAmount)).toBe(2);
    expect(Number(data.total)).toBe(22);
  });

  it("takes a new tip when one is sent", async () => {
    const { data } = await edit(existing({ deliveryFee: 0 }), {
      items: items(20),
      subtotal: 20,
      tipAmount: 3,
      total: 20,
    });
    expect(Number(data.tipAmount)).toBe(3);
    expect(Number(data.total)).toBe(23);
  });

  it("never returns a negative total", async () => {
    const { data } = await edit(existing({ deliveryFee: 0 }), {
      items: items(5),
      subtotal: 5,
      discount: 50,
      total: 0,
    });
    expect(Number(data.total)).toBe(0);
  });

  it("ignores the total the client sent", async () => {
    // The till and the voice agent each add an order up their own way, so
    // the server works from the parts and never from their answer.
    const { data } = await edit(existing({ deliveryFee: 0 }), {
      items: items(20),
      subtotal: 20,
      total: 999,
    });
    expect(Number(data.total)).toBe(20);
  });

  it("reports the total it actually wrote in the order history", async () => {
    // The note is what an operator reads back when a customer queries the
    // bill; quoting a number nobody was charged is worse than no note.
    const { note } = await edit(
      existing({ serviceCharge: 2.4, deliveryFee: 0, total: 22.4 }),
      { items: items(30), subtotal: 30, total: 30 },
    );
    expect(note).toContain("£22.40 → £32.40");
  });

  it("rounds to the penny", async () => {
    const { data } = await edit(existing({ deliveryFee: 0, taxAmount: 0 }), {
      items: items(10.1),
      subtotal: 10.1,
      deliveryFee: 2.2,
      total: 12.3,
    });
    expect(Number(data.total)).toBe(12.3);
  });
});
