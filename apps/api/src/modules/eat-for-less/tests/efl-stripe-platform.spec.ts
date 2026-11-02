import { PaymentsService } from "../../payments/payments.service";
import { EflPayoutsService, payoutStatusOf } from "../efl-payouts.service";

/** PaymentsService with Eat For Less's Stripe swapped for a fake. */
function paymentsWith(prisma: any, eflStripe: any, env: Record<string, string> = {}) {
  const config: any = { get: (k: string) => env[k] };
  const events: any = { emit: jest.fn() };
  const svc = new PaymentsService(prisma, {} as any, config, events, {} as any, {} as any);
  (svc as any).eflStripe = eflStripe;
  return { svc, events };
}

describe("Eat For Less charges on its own Stripe", () => {
  const order = {
    id: "o1",
    tenantId: "t1",
    locationId: "loc",
    orderSource: "EAT_FOR_LESS",
    total: 23.5,
    subtotal: 20,
    discount: 0,
    eflCommissionPercent: 8,
    eflAdRecovered: 3,
  };

  it("charges the customer as Eat For Less and transfers the shop's share", async () => {
    const created: any[] = [];
    const prisma: any = {
      order: { findFirst: jest.fn().mockResolvedValue(order) },
      eflListing: { findUnique: jest.fn().mockResolvedValue({ stripeAccountId: "acct_shop", stripePayoutsEnabled: true }) },
      payment: { create: jest.fn(async ({ data }: any) => created.push(data)) },
    };
    const stripe = { paymentIntents: { create: jest.fn().mockResolvedValue({ id: "pi_1", client_secret: "pi_1_secret" }) } };
    const { svc } = paymentsWith(prisma, stripe, { EFL_STRIPE_PUBLISHABLE_KEY: "pk_efl" });

    const out = await svc.createStorefrontPaymentIntent({ tenantId: "t1", orderId: "o1" });

    const [params, opts] = stripe.paymentIntents.create.mock.calls[0];
    expect(opts).toBeUndefined(); // the platform itself, not a connected account
    expect(params.amount).toBe(2350);
    expect(params.application_fee_amount).toBe(160 + 300); // 8% of £20 + £3 ads
    expect(params.transfer_data).toEqual({ destination: "acct_shop" });
    expect(params.metadata.platform).toBe("efl");
    expect(out).toEqual({ clientSecret: "pi_1_secret", amountPence: 2350, stripeAccountId: null, publishableKey: "pk_efl" });
    expect(created[0].metadata).toEqual({ platform: "efl", destination: "acct_shop" });
  });

  it("won't take an order for a shop Stripe can't pay", async () => {
    const prisma: any = {
      order: { findFirst: jest.fn().mockResolvedValue(order) },
      eflListing: { findUnique: jest.fn().mockResolvedValue({ stripeAccountId: "acct_shop", stripePayoutsEnabled: false }) },
    };
    const { svc } = paymentsWith(prisma, { paymentIntents: { create: jest.fn() } });
    await expect(svc.createStorefrontPaymentIntent({ tenantId: "t1", orderId: "o1" })).rejects.toThrow(/payout setup/);
  });

  it("refunds an Eat For Less charge on Eat For Less, taking back the transfer and our fee", async () => {
    const prisma: any = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: "p1",
          tenantId: "t1",
          orderId: "o1",
          stripePaymentIntentId: "pi_1",
          status: "SUCCEEDED",
          amount: 23.5,
          tipAmount: 0,
          metadata: { platform: "efl" },
        }),
        update: jest.fn(),
      },
      order: { update: jest.fn() },
    };
    const stripe = { refunds: { create: jest.fn().mockResolvedValue({ id: "re_1" }) } };
    const { svc } = paymentsWith(prisma, stripe);
    (svc as any).stripe = { refunds: { create: jest.fn() } };

    await svc.refundForOrder("o1", "shop rejected");

    const [params, opts] = stripe.refunds.create.mock.calls[0];
    expect(opts).toBeUndefined();
    expect(params).toMatchObject({ payment_intent: "pi_1", amount: 2350, reverse_transfer: true, refund_application_fee: true });
    expect((svc as any).stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("only lets payment events through its webhook, and passes account updates on", async () => {
    const event = (type: string) => ({ type, data: { object: { id: "acct_shop" } } });
    const stripe = { webhooks: { constructEvent: jest.fn() } };
    const { svc, events } = paymentsWith({}, stripe, { EFL_STRIPE_WEBHOOK_SECRET: "whsec" });
    const dispatch = jest.spyOn(svc, "dispatchStripeEvent").mockResolvedValue(undefined);

    stripe.webhooks.constructEvent.mockReturnValueOnce(event("payout.paid"));
    await svc.handleEflStripeWebhook(Buffer.from("{}"), "sig");
    expect(dispatch).not.toHaveBeenCalled();

    stripe.webhooks.constructEvent.mockReturnValueOnce(event("payment_intent.succeeded"));
    await svc.handleEflStripeWebhook(Buffer.from("{}"), "sig");
    expect(dispatch).toHaveBeenCalledTimes(1);

    stripe.webhooks.constructEvent.mockReturnValueOnce(event("account.updated"));
    await svc.handleEflStripeWebhook(Buffer.from("{}"), "sig");
    expect(events.emit).toHaveBeenCalledWith("efl.stripe_account.updated", { id: "acct_shop" });

    stripe.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error("bad sig");
    });
    await expect(svc.handleEflStripeWebhook(Buffer.from("{}"), "x")).rejects.toThrow(/signature/);
  });
});

describe("shop payouts", () => {
  it("are ready only when Stripe can pay the shop's bank", () => {
    expect(payoutStatusOf({ payouts_enabled: true, capabilities: { transfers: "active" } }).ready).toBe(true);
    expect(payoutStatusOf({ payouts_enabled: true, capabilities: { transfers: "pending" } }).ready).toBe(false);
    expect(
      payoutStatusOf({ payouts_enabled: false, requirements: { currently_due: ["external_account"], past_due: ["external_account"] } }).due,
    ).toEqual(["external_account"]);
  });

  it("creates one Express account per shop, paid weekly on Mondays", async () => {
    const listing = { id: "L1", stripeAccountId: null, stripePayoutsEnabled: false, location: { name: "Shop", brand: { name: "Pizza Pizza" } } };
    const prisma: any = {
      eflListing: {
        findUnique: jest.fn().mockResolvedValue(listing),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const stripe = {
      accounts: { create: jest.fn().mockResolvedValue({ id: "acct_new" }), del: jest.fn() },
      accountLinks: { create: jest.fn().mockResolvedValue({ url: "https://connect.stripe.com/x" }) },
    };
    const svc = new EflPayoutsService(prisma, { eflStripeClient: () => stripe } as any);

    await expect(svc.start("loc")).resolves.toEqual({ url: "https://connect.stripe.com/x" });
    const params = stripe.accounts.create.mock.calls[0][0];
    expect(params).toMatchObject({ type: "express", country: "GB", capabilities: { transfers: { requested: true } } });
    expect(params.settings.payouts.schedule).toEqual({ interval: "weekly", weekly_anchor: "monday" });
    expect(prisma.eflListing.updateMany).toHaveBeenCalledWith({
      where: { id: "L1", stripeAccountId: null },
      data: { stripeAccountId: "acct_new" },
    });
    expect(stripe.accountLinks.create.mock.calls[0][0].return_url).toMatch(/\/dashboard\/locations\/loc\/brands\?efl=payouts$/);
  });

  it("says so when Eat For Less's Stripe isn't set up yet", async () => {
    const prisma: any = { eflListing: { findUnique: jest.fn().mockResolvedValue({ id: "L1", stripeAccountId: null, location: {} }) } };
    const svc = new EflPayoutsService(prisma, { eflStripeClient: () => null } as any);
    await expect(svc.status("loc")).resolves.toEqual({ configured: false, status: "NOT_STARTED", due: [] });
    await expect(svc.start("loc")).rejects.toThrow(/aren't switched on/);
  });
});
