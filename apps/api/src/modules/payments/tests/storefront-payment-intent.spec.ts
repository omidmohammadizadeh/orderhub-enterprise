import { PaymentsService } from "../payments.service";

// The PaymentIntent behind paying without leaving the site.
//
// It has to reach the SAME answers as the hosted Checkout Session for the two
// questions that decide where money lands: which Connect account, and how much
// of it is ours. Two different answers is exactly how a storefront and a payout
// start disagreeing — so the resolution is pinned here rather than trusted to
// stay in step by inspection.

const TENANT = "t1";

function makeService(opts: {
  order?: any;
  connect?: { id: string | null; stripeAccountId: string } | null;
} = {}) {
  const created: any[] = [];
  const callOpts: any[] = [];
  const payments: any[] = [];
  const order = opts.order ?? {
    id: "o1",
    tenantId: TENANT,
    locationId: "loc1",
    brandId: "b1",
    total: 24,
    location: { applicationFeeMode: "none" },
    brand: {
      id: "b1",
      applicationFeeMode: "percentage_only",
      applicationFeePercentage: 5,
      applicationFeeFixedAmount: 0,
    },
  };
  const prisma: any = {
    order: { findFirst: async () => order },
    payment: {
      create: async (p: any) => {
        payments.push(p);
        return { id: "pay1" };
      },
    },
  };
  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.stripe = {
    paymentMethodDomains: {
      create: async () => ({ apple_pay: { status: "active" } }),
    },
    paymentIntents: {
      create: async (p: any, o?: any) => {
        created.push(p);
        callOpts.push(o);
        return { id: "pi_1", client_secret: "cs_test_1" };
      },
    },
  };
  svc.resolveConnectAccount = async () =>
    opts.connect === undefined
      ? { id: "c1", stripeAccountId: "acct_brand" }
      : opts.connect;
  return { svc, created, callOpts, payments };
}

const intentCallFor = async (o?: any) => {
  const { svc, created, callOpts } = makeService(o ? { order: o } : {});
  await svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" });
  return { created: created[0], opts: callOpts[0] };
};

const intentFor = async (o?: any) => (await intentCallFor(o)).created;

describe("createStorefrontPaymentIntent", () => {
  it("charges the order total in pence", async () => {
    expect((await intentFor()).amount).toBe(2400);
  });

  it("captures immediately — a wallet payment settles then and there", async () => {
    expect((await intentFor()).capture_method).toBe("automatic");
  });

  it("charges DIRECTLY on the restaurant's account, not the platform's", async () => {
    // The hosted session moved to direct charges because destination
    // charges need the `transfers` capability, which broke on first
    // deploy. A destination charge here would reintroduce exactly that
    // failure on the same accounts — so the request option is pinned,
    // and transfer_data must stay absent.
    const { created, opts } = await intentCallFor();
    expect(opts).toEqual({ stripeAccount: "acct_brand" });
    expect("transfer_data" in created).toBe(false);
  });

  it("returns the account the browser must construct Stripe.js with", async () => {
    // A direct-charge secret cannot be confirmed from the platform, so
    // omitting this silently breaks confirmation in the browser.
    const { svc } = makeService();
    const res = await svc.createStorefrontPaymentIntent({
      tenantId: TENANT,
      orderId: "o1",
    });
    expect(res.stripeAccountId).toBe("acct_brand");
  });

  it("writes the Payment row the webhook needs to find the order", async () => {
    // markPaid looks the order up THROUGH a Payment row and returns early
    // when there isn't one. No row means a customer is charged and the
    // order never reaches the staff board.
    const { svc, payments } = makeService();
    await svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" });
    expect(payments).toHaveLength(1);
    expect(payments[0].data.stripePaymentIntentId).toBe("pi_1");
    expect(payments[0].data.orderId).toBe("o1");
    expect(payments[0].data.status).toBe("PENDING");
  });

  it("takes the platform's percentage as the application fee", async () => {
    // 5% of £24 = £1.20.
    expect((await intentFor()).application_fee_amount).toBe(120);
  });

  it("omits the fee entirely when the brand charges none", async () => {
    const intent = await intentFor({
      id: "o1",
      tenantId: TENANT,
      locationId: "loc1",
      total: 24,
      location: { applicationFeeMode: "none" },
      brand: { id: "b1", applicationFeeMode: "none" },
    });
    // A zero application_fee_amount is not the same as omitting it; Stripe
    // rejects some zero-fee shapes, so it must be absent.
    expect("application_fee_amount" in intent).toBe(false);
  });

  it("adds the fixed surcharge to what the customer is charged", async () => {
    // £24 of food + a £0.50 visible service charge = £24.50 taken.
    const intent = await intentFor({
      id: "o1",
      tenantId: TENANT,
      locationId: "loc1",
      total: 24,
      location: { applicationFeeMode: "none" },
      brand: {
        id: "b1",
        applicationFeeMode: "fixed_only",
        applicationFeeFixedAmount: 0.5,
        applicationFeePercentage: 0,
      },
    });
    expect(intent.amount).toBe(2450);
    expect(intent.application_fee_amount).toBe(50);
  });

  it("falls back to the location's fee when the brand sets none", async () => {
    const intent = await intentFor({
      id: "o1",
      tenantId: TENANT,
      locationId: "loc1",
      total: 100,
      location: {
        applicationFeeMode: "percentage_only",
        applicationFeePercentage: 10,
        applicationFeeFixedAmount: 0,
      },
      brand: { id: "b1", applicationFeeMode: "none" },
    });
    expect(intent.application_fee_amount).toBe(1000);
  });

  it("offers cards and wallets only — no buy-now-pay-later", async () => {
    // automatic_payment_methods offers everything the account has enabled,
    // which put Klarna in front of a £12 takeaway and pushed the wallet
    // buttons down. "card" still covers Apple Pay and Google Pay: Stripe
    // presents wallet tokens as card payments.
    const intent = await intentFor();
    expect(intent.payment_method_types).toEqual(["card"]);
    expect("automatic_payment_methods" in intent).toBe(false);
  });

  it("carries the order id so the webhook can find it again", async () => {
    expect((await intentFor()).metadata.orderId).toBe("o1");
  });

  it("still takes the payment when wallet-domain registration blows up", async () => {
    // Registering the Apple Pay domain is best-effort decoration around the
    // charge. An outage there must cost the wallet button and nothing else —
    // the first cut of this threw synchronously and killed the PaymentIntent.
    const { svc } = makeService();
    svc.stripe.paymentMethodDomains = {
      create: async () => {
        throw new Error("Stripe is down");
      },
    };
    const res = await svc.createStorefrontPaymentIntent({
      tenantId: TENANT,
      orderId: "o1",
    });
    expect(res.clientSecret).toBe("cs_test_1");
  });

  it("registers the domain against the CONNECTED account, not the platform", async () => {
    // Direct charges mean Stripe looks for the registration on the account
    // running the charge. Registering platform-side leaves Apple Pay dark on
    // every shop, with no error anywhere — the original bug.
    const { svc } = makeService();
    const calls: any[] = [];
    svc.stripe.paymentMethodDomains = {
      create: async (body: any, opts: any) => {
        calls.push({ body, opts });
        return { apple_pay: { status: "active" } };
      },
    };
    await svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.opts?.stripeAccount === "acct_brand")).toBe(true);
  });

  it("registers both the apex and www spellings of a domain", async () => {
    // Stripe registers an exact host, not a site. A shop stored apex but
    // served on www gets card-only, with nothing anywhere to say why.
    const { svc } = makeService({
      order: {
        id: "o1",
        tenantId: TENANT,
        locationId: "loc1",
        total: 24,
        location: { applicationFeeMode: "none" },
        brand: { id: "b1", applicationFeeMode: "none", customDomain: "shop.co.uk" },
      },
    });
    const domains: string[] = [];
    svc.stripe.paymentMethodDomains = {
      create: async (body: any) => {
        domains.push(body.domain_name);
        return { apple_pay: { status: "active" } };
      },
    };
    await svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" });
    expect(domains).toContain("shop.co.uk");
    expect(domains).toContain("www.shop.co.uk");
  });

  it("refuses when the brand has no Connect account", async () => {
    const { svc } = makeService({ connect: null });
    await expect(
      svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" }),
    ).rejects.toThrow(/Stripe Connect/i);
  });
});
