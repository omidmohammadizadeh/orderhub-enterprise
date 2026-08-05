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
  };
  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.stripe = {
    paymentIntents: {
      create: async (p: any) => {
        created.push(p);
        return { id: "pi_1", client_secret: "cs_test_1" };
      },
    },
  };
  svc.resolveConnectAccount = async () =>
    opts.connect === undefined
      ? { id: "c1", stripeAccountId: "acct_brand" }
      : opts.connect;
  return { svc, created };
}

const intentFor = async (o?: any) => {
  const { svc, created } = makeService(o ? { order: o } : {});
  await svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" });
  return created[0];
};

describe("createStorefrontPaymentIntent", () => {
  it("charges the order total in pence", async () => {
    expect((await intentFor()).amount).toBe(2400);
  });

  it("authorises without capturing, so an unaccepted order isn't taken", async () => {
    expect((await intentFor()).capture_method).toBe("manual");
  });

  it("sends the money to the resolved Connect account", async () => {
    expect((await intentFor()).transfer_data).toEqual({
      destination: "acct_brand",
    });
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

  it("carries the order id so the webhook can find it again", async () => {
    expect((await intentFor()).metadata.orderId).toBe("o1");
  });

  it("refuses when the brand has no Connect account", async () => {
    const { svc } = makeService({ connect: null });
    await expect(
      svc.createStorefrontPaymentIntent({ tenantId: TENANT, orderId: "o1" }),
    ).rejects.toThrow(/Stripe Connect/i);
  });
});
