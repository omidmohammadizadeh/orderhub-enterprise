// Sending a payment link from the order panel: any unpaid till order can take
// one, not only cash. A collection taken as "card at the counter" and then
// switched to DELIVERY can't be paid at the counter any more — the link is the
// only way left — and the order must move onto PAYMENT_LINK so the board shows
// it as waiting for payment instead of expecting a card machine at the door.
import { BadRequestException } from "@nestjs/common";
import { PaymentsService } from "../payments.service";

function make(order: Record<string, unknown>) {
  const svc = Object.create(PaymentsService.prototype) as any;
  const update = jest.fn().mockResolvedValue({});
  svc.prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: "ord-1",
        locationId: "loc-1",
        brandId: "brand-1",
        total: 13.4,
        deliveryFee: 3,
        taxAmount: 0,
        tipAmount: 0,
        paymentStatus: "PENDING",
        items: [{ name: "Cluckin' Bliss", unitPrice: 10.4, quantity: 1 }],
        location: { onlineOrderingSlug: "pizza-uno" },
        brand: null,
        ...order,
      }),
      update,
    },
    payment: { create: jest.fn().mockResolvedValue({ id: "pay-1" }) },
  };
  svc.stripe = {
    checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: "cs_1", url: "https://pay.stripe.test/cs_1", payment_intent: "pi_1" }) } },
  };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.resolveConnectAccount = jest.fn().mockResolvedValue({ id: "ca-1", stripeAccountId: "acct_brand" });
  return { svc, update };
}

const movedToLink = (update: jest.Mock) =>
  update.mock.calls.some(([a]) => a?.data?.paymentMethod === "PAYMENT_LINK");

describe("createOrderPaymentLink — which orders move onto Payment link", () => {
  it.each(["CASH", "CARD_TERMINAL", null])("an unpaid %s order is switched to PAYMENT_LINK", async (method) => {
    const { svc, update } = make({ paymentMethod: method, fulfillmentType: "DELIVERY" });
    const r = await svc.createOrderPaymentLink("t-1", "ord-1");
    expect(r.url).toBe("https://pay.stripe.test/cs_1");
    expect(movedToLink(update)).toBe(true);
  });

  it.each(["PAYMENT_LINK", "QR_CODE"])("a %s order keeps its method (that is a resend)", async (method) => {
    const { svc, update } = make({ paymentMethod: method });
    await svc.createOrderPaymentLink("t-1", "ord-1");
    expect(movedToLink(update)).toBe(false);
  });

  it("refuses an order that is already paid", async () => {
    const { svc, update } = make({ paymentMethod: "CARD_TERMINAL", paymentStatus: "PAID" });
    await expect(svc.createOrderPaymentLink("t-1", "ord-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
});
