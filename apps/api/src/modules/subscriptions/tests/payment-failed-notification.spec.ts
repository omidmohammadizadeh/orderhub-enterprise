import { SubscriptionsService } from "../subscriptions.service";

// invoice.payment_failed used to only write lastFailureMessage onto the DB
// row, silently — nobody found out until someone happened to open that
// exact location's card on the Subscription page. This is the notification
// half of the fix: syncFromStripeInvoice now tells both the client and ops
// the moment a payment attempt fails.

const LOCATION_ID = "loc-1";

function makeService(opts: { stripe?: any; alertEmail?: any }) {
  const state = {
    sub: {
      id: "sub-row-1",
      locationId: LOCATION_ID,
      stripeSubscriptionId: "sub_stripe_1",
      stripeCustomerId: "cus_1",
      currency: "gbp",
      location: { name: "Castle Grill" },
    },
  };
  const prisma: any = {
    merchantSubscription: {
      findFirst: async () => state.sub,
      update: async ({ data }: any) => {
        state.sub = { ...state.sub, ...data };
        return state.sub;
      },
    },
  };
  const alertEmail = opts.alertEmail ?? {
    notifyPaymentFailed: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new SubscriptionsService(
    prisma,
    { get: () => undefined } as any,
    alertEmail,
  );
  if (opts.stripe) {
    (svc as any).stripe = opts.stripe;
  }
  return { svc, state, alertEmail };
}

describe("syncFromStripeInvoice — payment-failed notification", () => {
  it("notifies with the client's email when Stripe has one on file", async () => {
    const stripe = {
      customers: {
        retrieve: jest.fn().mockResolvedValue({ email: "owner@castlegrill.example" }),
      },
    };
    const { svc, alertEmail } = makeService({ stripe });

    await svc.syncFromStripeInvoice({
      subscription: "sub_stripe_1",
      status: "open",
      amount_due: 6000,
      currency: "gbp",
      last_payment_error: { message: "Your card has insufficient funds." },
    });

    expect(alertEmail.notifyPaymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        locationName: "Castle Grill",
        amountDue: 6000,
        currency: "gbp",
        failureMessage: "Your card has insufficient funds.",
        clientEmail: "owner@castlegrill.example",
      }),
    );
  });

  it("still notifies ops even when Stripe has no email for the customer", async () => {
    const stripe = {
      customers: { retrieve: jest.fn().mockResolvedValue({ email: null }) },
    };
    const { svc, alertEmail } = makeService({ stripe });

    await svc.syncFromStripeInvoice({
      subscription: "sub_stripe_1",
      status: "open",
      amount_due: 6000,
      currency: "gbp",
    });

    expect(alertEmail.notifyPaymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ clientEmail: null }),
    );
  });

  it("never notifies on a paid invoice", async () => {
    const stripe = {
      customers: { retrieve: jest.fn().mockResolvedValue({ email: "x@y.com" }) },
    };
    const { svc, alertEmail } = makeService({ stripe });

    await svc.syncFromStripeInvoice({
      subscription: "sub_stripe_1",
      status: "paid",
      amount_due: 6000,
      currency: "gbp",
    });

    expect(alertEmail.notifyPaymentFailed).not.toHaveBeenCalled();
  });

  it("degrades to no client email (not a crash) when Stripe isn't configured", async () => {
    const { svc, alertEmail } = makeService({});

    await svc.syncFromStripeInvoice({
      subscription: "sub_stripe_1",
      status: "open",
      amount_due: 6000,
      currency: "gbp",
    });

    expect(alertEmail.notifyPaymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ clientEmail: null }),
    );
  });

  it("doesn't let a notification failure block the DB update", async () => {
    const stripe = {
      customers: { retrieve: jest.fn().mockResolvedValue({ email: "x@y.com" }) },
    };
    const alertEmail = {
      notifyPaymentFailed: jest.fn().mockRejectedValue(new Error("Resend down")),
    };
    const { svc, state } = makeService({ stripe, alertEmail });

    await svc.syncFromStripeInvoice({
      subscription: "sub_stripe_1",
      status: "open",
      amount_due: 6000,
      currency: "gbp",
      last_payment_error: { message: "declined" },
    });

    expect(state.sub.lastInvoiceStatus).toBe("open");
    expect(state.sub.lastFailureMessage).toBe("declined");
  });
});
