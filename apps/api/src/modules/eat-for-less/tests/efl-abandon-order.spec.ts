import { ABANDONED_REASON, EflService } from "../efl.service";

// Pay → back out → change the basket: the order made for the old basket is
// never going to be paid, and left alone it sat on the Orders tab as
// "Waiting for payment" for good. It goes — but only while it's unpaid.

function setup(opts: { unpaidReads?: boolean[]; cancelThrows?: boolean } = {}) {
  const reads = [...(opts.unpaidReads ?? [true, true])];
  const prisma: any = {
    order: {
      findFirst: jest.fn(async () => (reads.shift() ? { id: "o1" } : null)),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const ordering: any = { getOrderStatus: jest.fn(async () => ({})) };
  const payments: any = {
    cancelAuthForOrder: jest.fn(async () => {
      if (opts.cancelThrows) throw new Error("This PaymentIntent has already succeeded");
    }),
  };
  const svc = new EflService(prisma, ordering, {} as any, {} as any, payments);
  return { svc, prisma, ordering, payments };
}

describe("abandonMyOrder", () => {
  it("releases the payment and cancels an unpaid order", async () => {
    const { svc, prisma, ordering, payments } = setup();
    await expect(svc.abandonMyOrder({ id: "c1" }, "o1")).resolves.toEqual({ abandoned: true });
    expect(ordering.getOrderStatus).toHaveBeenCalledWith("o1");
    expect(payments.cancelAuthForOrder).toHaveBeenCalledWith("o1", ABANDONED_REASON);
    expect(prisma.order.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "o1", status: "PENDING", paymentStatus: "PENDING" },
      data: { status: "CANCELLED", cancelReason: ABANDONED_REASON },
    });
    // Only the customer's own Eat For Less order.
    expect(prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ id: "o1", customerAccountId: "c1", orderSource: "EAT_FOR_LESS" });
  });

  it("leaves an order alone once the payment has landed", async () => {
    const { svc, prisma, payments } = setup({ unpaidReads: [true, false] });
    await expect(svc.abandonMyOrder({ id: "c1" }, "o1")).resolves.toEqual({ abandoned: false });
    expect(payments.cancelAuthForOrder).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the order when the card hold can't be released", async () => {
    const { svc, prisma } = setup({ cancelThrows: true });
    await expect(svc.abandonMyOrder({ id: "c1" }, "o1")).resolves.toEqual({ abandoned: false });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing for an order that isn't this customer's or isn't unpaid", async () => {
    const { svc, ordering } = setup({ unpaidReads: [false] });
    await expect(svc.abandonMyOrder({ id: "c1" }, "o1")).resolves.toEqual({ abandoned: false });
    expect(ordering.getOrderStatus).not.toHaveBeenCalled();
  });
});
