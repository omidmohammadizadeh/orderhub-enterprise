// Whether a paid order actually reaches the people who have to cook it.
//
// confirmPayment is the ONLY webhook an embedded storefront payment produces:
// capture is automatic, so there's no earlier amount_capturable_updated and no
// markAuthorized to announce the order. If this method doesn't broadcast, the
// customer is charged, the order sits PAID and PENDING, and nobody in the shop
// ever finds out. That happened in production — the broadcast was gated to the
// payment-link methods, and storefront CARD fell straight through the gap.
//
// The gate is pinned here per payment method because the failure is silent:
// nothing errors, nothing logs, the money is simply taken for food no one
// starts making.

import { PaymentsService } from "../payments.service";

const TENANT = "t1";

function makeService(order: {
  paymentMethod: string;
  orderSource?: string;
  status?: string;
}) {
  const emitted: any[] = [];
  const events: any[] = [];
  const orderRow = {
    id: "o1",
    tenantId: TENANT,
    locationId: "loc1",
    status: order.status ?? "PENDING",
    orderSource: order.orderSource ?? "ONLINE",
    paymentMethod: order.paymentMethod,
    platform: null,
    fulfillmentType: "PICKUP",
    displayId: "A12",
    total: 24,
    customerName: "Sam",
    scheduledFor: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    items: [{ quantity: 2 }],
  };

  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = {
    payment: {
      findFirst: async () => ({
        id: "pay1",
        orderId: "o1",
        tenantId: TENANT,
        amount: 24,
        tipAmount: 0,
        platformFee: 1.2,
        processingFee: 0.5,
        currency: "gbp",
        status: "PENDING",
      }),
      update: async (a: any) => a,
    },
    ledgerEntry: { create: (a: any) => a },
    order: { update: (a: any) => a, findUnique: async () => orderRow },
    $transaction: async () => [],
  };
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.socket = {
    emitToTenant() {},
    emitNewOrder: (locationId: string, payload: any) =>
      emitted.push({ locationId, payload }),
  };
  svc.events = { emit: (name: string, p: any) => events.push({ name, p }) };
  return { svc, emitted, events };
}

const announce = async (order: Parameters<typeof makeService>[0]) => {
  const { svc, emitted, events } = makeService(order);
  await svc.confirmPayment(TENANT, "pi_1");
  return { emitted, events };
};

describe("confirmPayment — reaching the staff board", () => {
  it("announces an embedded storefront CARD order", async () => {
    // The regression. Capture is automatic, so this webhook is the order's
    // only chance to appear in New.
    const { emitted, events } = await announce({
      paymentMethod: "CARD",
      orderSource: "ONLINE",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].locationId).toBe("loc1");
    // Auto-accept locations print the ticket off the back of this event.
    expect(events.map((e) => e.name)).toContain("payment.authorized");
  });

  it("still announces a POS payment-link order", async () => {
    const { emitted } = await announce({
      paymentMethod: "PAYMENT_LINK",
      orderSource: "POS",
    });
    expect(emitted).toHaveLength(1);
  });

  it("stays quiet for an order staff already accepted", async () => {
    // The authorise-then-capture path: markAuthorized announced it while it
    // was PENDING, staff accepted, and capture lands here afterwards. The
    // status guard — not the method list — is what prevents the double.
    const { emitted } = await announce({
      paymentMethod: "CARD",
      orderSource: "ONLINE",
      status: "ACCEPTED",
    });
    expect(emitted).toHaveLength(0);
  });

  it("stays quiet for a marketplace CARD order", async () => {
    // Deliveroo/Uber/HubRise settle on the channel side and are already on
    // the board. Re-announcing would double them up.
    const { emitted } = await announce({
      paymentMethod: "CARD",
      orderSource: "HUBRISE",
    });
    expect(emitted).toHaveLength(0);
  });
});
