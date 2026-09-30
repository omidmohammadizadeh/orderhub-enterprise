// A tip added ON the card machine has to reach the ORDER.
//
// Dojo certification, 2026-09-30: a waiter took £6.00 on a £5.40 share at the
// table. The 60p was written to the Payment row and nowhere else, so the order,
// the drawer and the printed receipt all showed a bill with no tip on it.
//
// The rule being pinned here: the tip lands on `order.tipAmount`, it is
// remembered as `terminalTipsMinor` so the till can print it AFTER the total,
// and `order.total` is never touched — five separate places work out what a
// table still owes by subtracting what's been paid from `total`, and inflating
// it would leave every one of them chasing money nobody owes.

jest.mock(
  "@nestjs/event-emitter",
  () => ({ EventEmitter2: class {}, OnEvent: () => () => undefined }),
  { virtual: true },
);

import { PaymentsService } from "../payments.service";

function makeService(order: any) {
  const svc = Object.create(PaymentsService.prototype) as any;
  const updates: any[] = [];
  svc.prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn((args: any) => {
        updates.push(args);
        return args;
      }),
    },
    payment: { update: jest.fn((args: any) => args) },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, updates };
}

describe("an order settled on a card machine", () => {
  it("stops calling itself cash", async () => {
    const { svc } = makeService({ tipAmount: 0, metadata: {} });
    svc.prisma.order.findUnique = jest.fn().mockResolvedValue({ paymentMethod: "CASH" });
    await svc.markPaidOnCardMachine({ orderId: "ord-1" });
    expect(svc.prisma.order.update).toHaveBeenCalledWith({
      where: { id: "ord-1" },
      data: { paymentMethod: "CARD_TERMINAL" },
    });
  });

  it("leaves an order that already knows how it was paid alone", async () => {
    for (const paymentMethod of ["CARD", "PAYMENT_LINK", "QR_CODE"]) {
      const { svc } = makeService({ tipAmount: 0, metadata: {} });
      svc.prisma.order.findUnique = jest.fn().mockResolvedValue({ paymentMethod });
      await svc.markPaidOnCardMachine({ orderId: "ord-1" });
      expect(svc.prisma.order.update).not.toHaveBeenCalled();
    }
  });
});

describe("a tip taken on the card machine", () => {
  const order = { tipAmount: 0, metadata: {} };

  it("goes onto the order, without changing what the table owes", async () => {
    const { svc, updates } = makeService(order);
    const payment = { id: "pay-1", orderId: "ord-1", tipAmount: 0.6, metadata: { split: true } };
    await svc.applyTerminalTip(payment);

    expect(updates).toHaveLength(1);
    expect(updates[0].data.tipAmount).toBe(0.6);
    expect(updates[0].data.metadata.terminalTipsMinor).toBe(60);
    // The bill itself is untouched.
    expect(updates[0].data).not.toHaveProperty("total");
  });

  it("adds up when several people tip on the same table", async () => {
    const { svc, updates } = makeService({ tipAmount: 0.6, metadata: { terminalTipsMinor: 60 } });
    await svc.applyTerminalTip({ id: "pay-2", orderId: "ord-1", tipAmount: 1.4, metadata: {} });
    expect(updates[0].data.tipAmount).toBeCloseTo(2);
    expect(updates[0].data.metadata.terminalTipsMinor).toBe(200);
  });

  it("only books the tip once, however many times the payment settles", async () => {
    const { svc, updates } = makeService(order);
    const payment = { id: "pay-1", orderId: "ord-1", tipAmount: 0.6, metadata: {} };
    await svc.applyTerminalTip(payment);
    await svc.applyTerminalTip(payment); // a webhook arriving after the poll
    expect(updates).toHaveLength(1);
  });

  it("does nothing at all when there was no tip", async () => {
    const { svc, updates } = makeService(order);
    await svc.applyTerminalTip({ id: "pay-1", orderId: "ord-1", tipAmount: 0, metadata: {} });
    expect(updates).toHaveLength(0);
  });

  it("never lets a failed tip write cost us the payment", async () => {
    const { svc } = makeService(order);
    svc.prisma.$transaction = jest.fn().mockRejectedValue(new Error("db down"));
    await expect(
      svc.applyTerminalTip({ id: "pay-1", orderId: "ord-1", tipAmount: 0.6, metadata: {} }),
    ).resolves.toBeUndefined();
    expect(svc.logger.error).toHaveBeenCalled();
  });
});
