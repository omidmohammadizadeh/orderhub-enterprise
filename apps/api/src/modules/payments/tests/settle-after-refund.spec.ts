// A refunded payment must never be banked a second time.
//
// The real failure (Dojo, order cmue9c1i…, 2026-09-23): a matched refund gave
// the customer their whole £7.50 back at 15:53:40, and 1.1 seconds later a
// routine Dojo webhook re-settled the same payment — Payment row back to
// SUCCEEDED, Order back to PAID. The shop's board then showed money it no
// longer had, and on a still-PENDING order it would also have re-fired
// auto-accept and reprinted the ticket.
//
// It slipped through because the idempotency guard only knew about SUCCEEDED,
// and a full refund leaves the row REFUNDED. Verifying with the provider
// cannot save us here: a card-machine refund is its OWN transaction, so the
// payment intent stays "Captured" for ever afterwards. Only our own refund
// record knows the money went back, which is why this is pinned.

import { PaymentsService } from "../payments.service";

function makeService(payment: any) {
  const svc = Object.create(PaymentsService.prototype) as any;
  const updates: any[] = [];
  svc.prisma = {
    payment: { update: (a: any) => updates.push({ model: "payment", ...a }) },
    order: {
      update: (a: any) => updates.push({ model: "order", ...a }),
      findUnique: async () => null,
    },
    $transaction: async (ops: any[]) => ops,
  };
  const warnings: string[] = [];
  svc.logger = { log() {}, warn: (m: string) => warnings.push(m), error() {} };
  svc.socket = { emitToTenant() {}, emitNewOrder() {} };
  svc.events = { emit() {} };
  return { svc, updates, warnings, payment };
}

const row = (over: any = {}) => ({
  id: "pay1",
  orderId: "o1",
  tenantId: "t1",
  amount: 7.5,
  status: "PROCESSING",
  metadata: {},
  ...over,
});

describe("settleCardPresentPayment — money that has gone back", () => {
  it("refuses to re-settle a fully refunded payment", async () => {
    const { svc, updates, warnings } = makeService(null);
    await svc.settleCardPresentPayment(
      row({ status: "REFUNDED", metadata: { refundedMinor: 750 } }),
      "pi_sandbox_x",
    );
    expect(updates).toHaveLength(0);
    expect(warnings[0]).toMatch(/already been refunded/i);
  });

  it("refuses when only part of it went back but the row is no longer SUCCEEDED", async () => {
    // Belt and braces: a part refund normally leaves the row SUCCEEDED (caught
    // by the idempotency guard), but a later provider retry must not resurrect
    // it through any other status either.
    const { svc, updates } = makeService(null);
    await svc.settleCardPresentPayment(row({ status: "PROCESSING", metadata: { refundedMinor: 200 } }), "pi_x");
    expect(updates).toHaveLength(0);
  });

  it("still settles a payment nothing has been refunded on", async () => {
    const { svc, updates } = makeService(null);
    await svc.settleCardPresentPayment(row(), "pi_x");
    expect(updates.map((u) => u.model)).toEqual(["payment", "order"]);
    expect(updates[1].data).toMatchObject({ paymentStatus: "PAID" });
  });

  it("stays a no-op on an already-settled payment", async () => {
    const { svc, updates } = makeService(null);
    await svc.settleCardPresentPayment(row({ status: "SUCCEEDED" }), "pi_x");
    expect(updates).toHaveLength(0);
  });
});
