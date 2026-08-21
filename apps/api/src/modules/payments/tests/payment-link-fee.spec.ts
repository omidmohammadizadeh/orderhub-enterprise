import { PaymentsService } from "../payments.service";

// A payment-link charge must never cost the customer more than the same order
// placed any other way. The fixed platform fee used to be appended to the
// Stripe page as a visible "Service charge" line, so the customer funded it.
// Both parts of the fee now come out of the restaurant's payout instead.
//
// Online ordering deliberately still surcharges — the regression guards below
// exist because both flows share this one method, and the only thing telling
// them apart is captureMethod.

function makeService(opts: {
  location?: any;
  brand?: any;
  total?: number;
  items?: any[];
  deliveryFee?: number;
}) {
  const sessions = { create: jest.fn().mockResolvedValue({ id: "cs_1", url: "https://pay", payment_intent: "pi_1" }) };
  const order = {
    id: "ord-1",
    locationId: "loc-1",
    brandId: "brand-1",
    total: opts.total ?? 20,
    deliveryFee: opts.deliveryFee ?? 0,
    taxAmount: 0,
    tipAmount: 0,
    paymentStatus: "UNPAID",
    items: opts.items ?? [{ name: "Pizza", unitPrice: opts.total ?? 20, quantity: 1 }],
    location: opts.location ?? {},
    brand: opts.brand ?? null,
  };
  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    payment: { create: jest.fn().mockResolvedValue({ id: "pay-1" }) },
  };
  svc.stripe = { checkout: { sessions } };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.resolveConnectAccount = jest
    .fn()
    .mockResolvedValue({ id: "ca-1", stripeAccountId: "acct_brand" });
  return { svc, sessions };
}

const call = (svc: any, captureMethod?: "automatic") =>
  svc.createCheckoutSession({
    tenantId: "t1",
    orderId: "ord-1",
    successUrl: "https://ok",
    cancelUrl: "https://no",
    ...(captureMethod ? { captureMethod } : {}),
  });

const sent = (sessions: any) => sessions.create.mock.calls[0][0];
const serviceCharge = (sessions: any) =>
  sent(sessions).line_items.find(
    (li: any) => li.price_data.product_data.name === "Service charge",
  );

// The location's own payment-link Stripe account + fee (the screenshot's
// "Payment link settings": 0.05% and £0.20 fixed).
const POS_LOCATION = {
  posStripeAccountId: "acct_shop",
  posApplicationFeePercent: 5,
  posApplicationFeeFixedMinor: 20,
};

describe("payment link — dedicated Stripe account", () => {
  it("does not add a Service charge line to the customer's bill", async () => {
    const { svc, sessions } = makeService({ location: POS_LOCATION, total: 20 });
    await call(svc, "automatic");
    expect(serviceCharge(sessions)).toBeUndefined();
  });

  it("still collects the fixed fee, taken from the restaurant's payout", async () => {
    const { svc, sessions } = makeService({ location: POS_LOCATION, total: 20 });
    await call(svc, "automatic");
    // £20 at 5% = 100p, plus the 20p fixed = 120p, all from the payout.
    expect(sent(sessions).payment_intent_data.application_fee_amount).toBe(120);
  });

  it("charges the customer exactly the basket total", async () => {
    const { svc, sessions } = makeService({ location: POS_LOCATION, total: 20 });
    await call(svc, "automatic");
    const charged = sent(sessions).line_items.reduce(
      (s: number, li: any) => s + li.price_data.unit_amount * li.quantity,
      0,
    );
    expect(charged).toBe(2000);
  });

  it("uses the location's own Stripe account", async () => {
    const { svc, sessions } = makeService({ location: POS_LOCATION });
    await call(svc, "automatic");
    expect(sessions.create.mock.calls[0][1]).toEqual({ stripeAccount: "acct_shop" });
  });
});

describe("payment link — no dedicated account, shared fee config", () => {
  // Falls through to the brand/location online-ordering fee config. The rule
  // must still hold: a payment link never surcharges the customer.
  const FEE_BRAND = {
    applicationFeeMode: "fixed_and_percentage",
    applicationFeeFixedAmount: 0.3,
    applicationFeePercentage: 4,
  };

  it("does not add a Service charge line", async () => {
    const { svc, sessions } = makeService({ brand: FEE_BRAND, total: 20 });
    await call(svc, "automatic");
    expect(serviceCharge(sessions)).toBeUndefined();
  });

  it("keeps the platform's cut identical, just sourced from the payout", async () => {
    const { svc, sessions } = makeService({ brand: FEE_BRAND, total: 20 });
    await call(svc, "automatic");
    // £0.30 fixed + 4% of £20 (£0.80) = 110p.
    expect(sent(sessions).payment_intent_data.application_fee_amount).toBe(110);
  });

  it("never lets the fee exceed what the customer is charged", async () => {
    // A £0.10 link with a £0.30 fixed fee — Stripe rejects a fee larger than
    // the charge, which would block collection at the till entirely.
    const { svc, sessions } = makeService({ brand: FEE_BRAND, total: 0.1 });
    await call(svc, "automatic");
    expect(sent(sessions).payment_intent_data.application_fee_amount).toBe(10);
  });
});

describe("online ordering is unchanged", () => {
  const FEE_BRAND = {
    applicationFeeMode: "fixed_and_percentage",
    applicationFeeFixedAmount: 0.3,
    applicationFeePercentage: 4,
  };

  it("still shows the customer a Service charge line", async () => {
    const { svc, sessions } = makeService({ brand: FEE_BRAND, total: 20 });
    await call(svc); // no captureMethod — the storefront path
    expect(serviceCharge(sessions)?.price_data.unit_amount).toBe(30);
  });

  it("still authorises for a staff Accept rather than capturing", async () => {
    const { svc, sessions } = makeService({ brand: FEE_BRAND, total: 20 });
    await call(svc);
    expect(sent(sessions).payment_intent_data.capture_method).toBe("manual");
  });

  it("keeps surcharging even when the location has payment-link settings", async () => {
    // The location carries a payment-link account and fee, but an online
    // order must ignore both.
    const { svc, sessions } = makeService({
      location: POS_LOCATION,
      brand: FEE_BRAND,
      total: 20,
    });
    await call(svc);
    expect(serviceCharge(sessions)?.price_data.unit_amount).toBe(30);
    expect(sessions.create.mock.calls[0][1]).toEqual({ stripeAccount: "acct_brand" });
  });
});
