import { PaymentsService } from "../payments.service";

// POST /v1/payments/:paymentId/refund must never book a refund that didn't
// happen. It used to call Stripe without {stripeAccount} (so every direct
// charge failed), swallow the error, and write Refund + ledger rows as
// SUCCEEDED anyway — or with a fake mock_re_ id when Stripe wasn't set up.

function setup(opts: {
  payment: Record<string, unknown>;
  otherPayments?: Array<Record<string, unknown>>;
  stripe?: { refunds: { create: jest.Mock } } | null;
}) {
  const payment = {
    id: "pay1",
    tenantId: "t1",
    orderId: "o1",
    amount: 20,
    tipAmount: 0,
    currency: "gbp",
    status: "SUCCEEDED",
    refunds: [] as any[],
    ...opts.payment,
  };
  const written = { refunds: [] as any[], ledger: [] as any[], paymentUpdates: [] as any[], orderUpdates: [] as any[] };
  const db: any = {
    payment: {
      findFirst: async () => payment,
      findMany: async () => [payment, ...(opts.otherPayments ?? [])],
      update: async (a: any) => written.paymentUpdates.push(a),
    },
    refund: {
      create: async ({ data }: any) => {
        const r = { id: `r${written.refunds.length + 1}`, ...data };
        written.refunds.push(r);
        return r;
      },
      findMany: async () => [...payment.refunds, ...written.refunds].filter((r) => r.status === "SUCCEEDED"),
    },
    ledgerEntry: { create: async ({ data }: any) => written.ledger.push(data) },
    order: { update: async (a: any) => written.orderUpdates.push(a) },
  };
  db.$transaction = (fn: any) => fn(db);

  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = db;
  svc.stripe = opts.stripe === undefined ? { refunds: { create: jest.fn(async () => ({ id: "re_1" })) } } : opts.stripe;
  svc.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  svc.socket = { emitToTenant: jest.fn() };
  svc.stripeAccountForPayment = jest.fn(async () => "acct_shop");
  return { svc: svc as PaymentsService, written, stripe: svc.stripe };
}

describe("PaymentsService.createRefund", () => {
  it("refunds a Stripe card payment on the connected account it lives on", async () => {
    const { svc, written, stripe } = setup({
      payment: { method: "CARD", provider: "STRIPE", stripePaymentIntentId: "pi_1" },
    });
    await svc.createRefund("t1", "pay1", { amount: 5, reason: "Faulty" });
    expect(stripe!.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1", amount: 500 }),
      { stripeAccount: "acct_shop" },
    );
    expect(written.refunds[0]).toMatchObject({ stripeRefundId: "re_1", method: "CARD", isPartial: true });
    expect(written.orderUpdates[0].data.paymentStatus).toBe("PARTIALLY_REFUNDED");
  });

  it("books NOTHING when Stripe refuses the refund", async () => {
    const create = jest.fn(async () => {
      throw new Error("No such payment_intent");
    });
    const { svc, written } = setup({
      payment: { method: "CARD", provider: "STRIPE", stripePaymentIntentId: "pi_1" },
      stripe: { refunds: { create } },
    });
    await expect(svc.createRefund("t1", "pay1", { amount: 5 })).rejects.toThrow(/declined by Stripe/);
    expect(written.refunds).toHaveLength(0);
    expect(written.ledger).toHaveLength(0);
    expect(written.orderUpdates).toHaveLength(0);
  });

  it("books NOTHING (and invents no mock id) when Stripe isn't configured", async () => {
    const { svc, written } = setup({
      payment: { method: "CARD", provider: "STRIPE", stripePaymentIntentId: "pi_1" },
      stripe: null,
    });
    await expect(svc.createRefund("t1", "pay1", { amount: 5 })).rejects.toThrow(/Stripe is not configured/);
    expect(written.refunds).toHaveLength(0);
  });

  it("records a cash refund without calling any provider", async () => {
    const { svc, written, stripe } = setup({ payment: { method: "CASH", provider: "STRIPE" } });
    await svc.createRefund("t1", "pay1", { amount: 20 });
    expect(stripe!.refunds.create).not.toHaveBeenCalled();
    expect(written.refunds[0]).toMatchObject({ stripeRefundId: null, method: "CASH", isPartial: false });
    expect(written.paymentUpdates[0].data.status).toBe("REFUNDED");
    expect(written.orderUpdates[0].data.paymentStatus).toBe("REFUNDED");
  });

  it.each([
    ["DOJO", /Dojo card machine/],
    ["TAP", /Tap payments/],
  ])("refuses a %s card payment instead of marking it refunded", async (provider, msg) => {
    const { svc, written } = setup({ payment: { method: "CARD", provider } });
    await expect(svc.createRefund("t1", "pay1", { amount: 5 })).rejects.toThrow(msg);
    expect(written.refunds).toHaveLength(0);
  });

  it("keeps a split bill PARTIALLY_REFUNDED when only one card has gone back", async () => {
    const { svc, written } = setup({
      payment: { method: "CARD", provider: "STRIPE", stripePaymentIntentId: "pi_1" },
      otherPayments: [{ id: "pay2", amount: 15, tipAmount: 0, status: "SUCCEEDED" }],
    });
    await svc.createRefund("t1", "pay1", { amount: 20 });
    expect(written.paymentUpdates[0].data.status).toBe("REFUNDED");
    expect(written.orderUpdates[0].data.paymentStatus).toBe("PARTIALLY_REFUNDED");
  });

  it("still refuses more than is left to refund", async () => {
    const { svc } = setup({
      payment: {
        method: "CASH",
        provider: "STRIPE",
        refunds: [{ amount: 15, status: "SUCCEEDED" }],
      },
    });
    await expect(svc.createRefund("t1", "pay1", { amount: 10 })).rejects.toThrow(/exceeds refundable amount 5/);
  });
});
