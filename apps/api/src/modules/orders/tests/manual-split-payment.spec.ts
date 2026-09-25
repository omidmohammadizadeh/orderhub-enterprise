// A recorded payment must not impersonate a Stripe one.
//
// addPayment writes the books for money taken somewhere we didn't process:
// cash in the drawer, or a card keyed into the shop's own standalone machine.
// Payment.provider defaults to "STRIPE", and that default is dangerous here —
// captureForOrder and refundForOrder both take the MOST RECENT row matching
// { method: "CARD", provider: "STRIPE" } on the order.
//
// So a manual record written after a genuine Stripe payment shadows it, and
// refundForOrder then bails on `!payment.stripePaymentIntentId` and returns
// silently. The customer's refund never happens and nothing is logged.
//
// Found 2026-09-25: a £4.13 split share on a table tab was stored as a
// STRIPE card payment with no charge id of any kind.

import { OrdersService } from "../orders.service";

function makeService(existing: any[] = []) {
  const created: any[] = [];
  const svc = Object.create(OrdersService.prototype) as any;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.prisma = {
    order: {
      findFirst: async () => ({ id: "o1", tenantId: "t1", tableId: "tbl1", total: 26.72 }),
      update: async (a: any) => a,
    },
    orderItem: { findMany: async () => [] },
    payment: {
      findMany: async () => existing,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: "pay-new", ...data };
      },
    },
  };
  // Only the money maths matters here, not the settle/close side effects.
  svc.paymentSummary = async () => ({
    remaining: 22.59,
    paid: 4.13,
    total: 26.72,
    paidItemIds: [],
  });
  svc.completeAndFreeTable = async () => undefined;
  return { svc, created };
}

describe("recording a payment taken outside our integrations", () => {
  it("does not label a manually recorded card payment as Stripe", async () => {
    const { svc, created } = makeService();
    await svc.addPayment("o1", "t1", { amount: 4.13, method: "CARD" }, "u1");
    expect(created[0]).toMatchObject({
      method: "CARD",
      status: "SUCCEEDED",
      provider: "MANUAL",
    });
    // The thing that made it dangerous: it looked like a Stripe charge while
    // carrying no Stripe reference at all.
    expect(created[0].stripePaymentIntentId).toBeUndefined();
    expect(created[0].providerChargeId).toBeUndefined();
  });

  it("labels recorded cash the same way", async () => {
    const { svc, created } = makeService();
    await svc.addPayment("o1", "t1", { amount: 10, method: "CASH" }, "u1");
    // Cash was never Stripe's either — the default was simply never set.
    expect(created[0].provider).toBe("MANUAL");
  });

  it("still books the amount and its source", async () => {
    const { svc, created } = makeService();
    await svc.addPayment("o1", "t1", { amount: 4.13, method: "CARD", note: "Split" }, "u1");
    expect(created[0].amount).toBe(4.13);
    expect(created[0].metadata).toMatchObject({ source: "SPLIT_BILL", takenBy: "u1" });
  });
});
