import { OrdersService } from "../orders.service";

// Call kwPJfhWA: a phone amendment added a drink and every kitchen screen
// dropped the order — "no items route here anymore". editOrder deleted every
// line and recreated them without menuItemId, which is what the KDS routes
// by; and even with it, every line got a new id, so a bumped station was
// re-opened by a change that never touched it.
const service = () => {
  const s: any = Object.create(OrdersService.prototype);
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.socket = { emitNewOrder: jest.fn(), emitOrderUpdated: jest.fn() };
  s.events = { emit: jest.fn() };
  return s;
};
const existing = () => ({
  id: "o1",
  tenantId: "t1",
  locationId: "l1",
  status: "PREPARING",
  paymentMethod: "CASH",
  paymentStatus: "PENDING",
  orderSource: "VOICE",
  platform: "VOICE",
  total: 25,
  customerInfo: null,
  customerName: "Omid",
  customerPhone: "+447700900123",
  deliveryAddress: null,
  specialInstructions: null,
  scheduledFor: null,
  createdAt: new Date(),
  items: [
    { id: "row-deal", name: "MEAL DEAL 2", quantity: 1, unitPrice: 25, totalPrice: 25, modifiers: [{ name: "DONNER KEBAB", price: 0, optionId: "k1" }], notes: null, menuItemId: "deal2" },
    { id: "row-gb", name: "Garlic Bread", quantity: 2, unitPrice: 3.5, totalPrice: 7, modifiers: [], notes: null, menuItemId: "gb" },
  ],
});
const prismaWith = (order: any) => {
  const tx = {
    orderItem: { update: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async () => ({})) },
    order: { update: jest.fn(async () => ({ ...order, items: undefined, total: 27.9 })) },
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
const line = (over: any) => ({ quantity: 1, totalPrice: 0, ...over });

describe("editOrder keeps the lines that did not change", () => {
  it("adding a drink creates one row, deletes none, and the existing rows keep their ids", async () => {
    const s = service(); const { prisma, tx } = prismaWith(existing()); s.prisma = prisma;
    await s.editOrder("o1", "t1", {
      items: [
        line({ name: "MEAL DEAL 2", unitPrice: 25, totalPrice: 25, modifiers: [{ name: "DONNER KEBAB", price: 0 }], menuItemId: "deal2" }),
        line({ name: "Garlic Bread", quantity: 2, unitPrice: 3.5, totalPrice: 7, menuItemId: "gb" }),
        line({ name: "CAN COKE", unitPrice: 1.2, totalPrice: 1.2, menuItemId: "coke" }),
      ],
      subtotal: 33.2,
      total: 33.2,
    }, "voice-ai");
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.orderItem.createMany).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.createMany.mock.calls[0][0].data).toEqual([
      { orderId: "o1", name: "CAN COKE", quantity: 1, unitPrice: 1.2, totalPrice: 1.2, modifiers: [], notes: null, menuItemId: "coke" },
    ]);
    expect(s.events.emit).toHaveBeenCalledWith("order.items_edited", { orderId: "o1", locationId: "l1" });
  });

  it("a removed line is deleted by id, a changed quantity is updated in place, and a line with no menu item is not guessed one", async () => {
    const s = service(); const { prisma, tx } = prismaWith(existing()); s.prisma = prisma;
    await s.editOrder("o1", "t1", {
      items: [
        line({ name: "MEAL DEAL 2", unitPrice: 25, totalPrice: 25, modifiers: [{ name: "DONNER KEBAB", price: 0 }] }), // no menuItemId sent: keeps its own
        line({ name: "Garlic Bread", quantity: 1, unitPrice: 3.5, totalPrice: 3.5, menuItemId: "gb" }),
      ],
      subtotal: 28.5,
      total: 28.5,
    }, "pos");
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.update.mock.calls[0][0]).toEqual({ where: { id: "row-gb" }, data: { quantity: 1, totalPrice: 3.5 } });
    expect(tx.orderItem.createMany).not.toHaveBeenCalled();

    const t = service(); const second = prismaWith(existing()); t.prisma = second.prisma;
    await t.editOrder("o1", "t1", {
      items: [line({ name: "MEAL DEAL 2", unitPrice: 25, totalPrice: 25, modifiers: [{ name: "DONNER KEBAB", price: 0 }], menuItemId: "deal2" })],
      subtotal: 25,
      total: 25,
    }, "pos");
    expect(second.tx.orderItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["row-gb"] } } });
    expect(second.tx.orderItem.createMany).not.toHaveBeenCalled();
  });

  it("a kept line that had no menu item picks one up when the edit supplies it, and never the other way round", async () => {
    const order = existing(); order.items[1].menuItemId = null;
    const s = service(); const { prisma, tx } = prismaWith(order); s.prisma = prisma;
    await s.editOrder("o1", "t1", {
      items: [
        line({ name: "MEAL DEAL 2", unitPrice: 25, totalPrice: 25, modifiers: [{ name: "DONNER KEBAB", price: 0 }], menuItemId: "other" }),
        line({ name: "Garlic Bread", quantity: 2, unitPrice: 3.5, totalPrice: 7, menuItemId: "gb" }),
      ],
      subtotal: 32,
      total: 32,
    }, "pos");
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.update.mock.calls[0][0]).toEqual({ where: { id: "row-gb" }, data: { menuItemId: "gb" } });
  });
});
