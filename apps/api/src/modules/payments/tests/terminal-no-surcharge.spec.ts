import { TerminalService } from "../terminal.service";

// Card-present must cost the customer exactly the order total: both the
// percentage and the fixed platform fee come out of the restaurant's payout
// via application_fee_amount, never as an extra line on the customer's bill.
//
// This was already true, unlike the payment-link flow which had to be changed.
// These tests exist so it STAYS true — the fee config is shared with online
// ordering, which does surcharge, and nothing structural kept the two apart.

function makeService(feePence: number, orderTotal = 20) {
  const paymentIntents = {
    create: jest.fn().mockResolvedValue({ id: "pi_1", client_secret: "cs" }),
  };
  const order = {
    id: "ord-1",
    tenantId: "t1",
    locationId: "loc-1",
    brandId: "brand-1",
    total: orderTotal,
    status: "PENDING",
    paymentStatus: "UNPAID",
  };
  const svc = Object.create(TerminalService.prototype) as any;
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    payment: { create: jest.fn().mockResolvedValue({ id: "pay-1" }) },
  };
  svc.assertStripe = jest.fn();
  svc.stripe = { paymentIntents };
  svc.client = jest.fn().mockReturnValue({ paymentIntents });
  svc.payments = {
    resolveConnectAccount: jest
      .fn()
      .mockResolvedValue({ id: "ca-1", stripeAccountId: "acct_shop" }),
    terminalApplicationFeePence: jest.fn().mockResolvedValue(feePence),
  };
  return { svc, paymentIntents };
}

const charge = (svc: any) =>
  svc.createMobileCharge({ tenantId: "t1", orderId: "ord-1" });

describe("card reader charge", () => {
  it("charges the customer the order total, with no fee added on top", async () => {
    const { svc, paymentIntents } = makeService(120, 20);
    await charge(svc);
    expect(paymentIntents.create.mock.calls[0][0].amount).toBe(2000);
  });

  it("takes the whole fee from the restaurant's payout instead", async () => {
    const { svc, paymentIntents } = makeService(120, 20);
    await charge(svc);
    expect(
      paymentIntents.create.mock.calls[0][0].application_fee_amount,
    ).toBe(120);
  });

  it("charges the same total whatever the fee is configured to be", async () => {
    const cheap = makeService(0, 20);
    const dear = makeService(500, 20);
    await charge(cheap.svc);
    await charge(dear.svc);
    expect(cheap.paymentIntents.create.mock.calls[0][0].amount).toBe(
      dear.paymentIntents.create.mock.calls[0][0].amount,
    );
  });

  it("records the fee as platform revenue, not customer revenue", async () => {
    const { svc } = makeService(120, 20);
    await charge(svc);
    const row = svc.prisma.payment.create.mock.calls[0][0].data;
    expect(Number(row.amount)).toBe(20);
    expect(Number(row.platformFee)).toBe(1.2);
    expect(Number(row.netAmount)).toBe(18.8);
  });
});
