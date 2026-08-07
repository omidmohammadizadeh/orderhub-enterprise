import { SubscriptionsService } from "../subscriptions.service";

// A destination not subscribed to an event type when it fired can never
// receive that event later — Stripe doesn't backfill deliveries just
// because the destination's config changed afterwards (the Castle Grill
// case: customer.subscription.created and invoice.paid both fired and
// were silently dropped since the destination only had 2 event types
// selected at the time). resyncFromStripe() is the fix: read the current
// truth straight from Stripe's API instead of depending on webhook
// history, and mirror it the same way the webhook handlers already do.

const LOCATION_ID = "loc-1";
const TENANT_ID = "tenant-1";

function makeService(opts: {
  sub?: any;
  userLocations?: string[];
  stripe?: any;
}) {
  const state = {
    sub: opts.sub ?? {
      id: "sub-row-1",
      tenantId: TENANT_ID,
      locationId: LOCATION_ID,
      stripeSubscriptionId: "sub_stripe_1",
      stripeCustomerId: "cus_1",
    },
  };
  const prisma: any = {
    userLocation: {
      findMany: async () =>
        (opts.userLocations ?? []).map((locationId) => ({ locationId })),
    },
    userBrand: { findMany: async () => [] },
    brand: { findMany: async () => [] },
    merchantSubscription: {
      findFirst: async ({ where }: any) => {
        if (where.stripeSubscriptionId) {
          return where.stripeSubscriptionId === state.sub.stripeSubscriptionId
            ? state.sub
            : null;
        }
        if (where.stripeCustomerId) {
          return where.stripeCustomerId === state.sub.stripeCustomerId
            ? state.sub
            : null;
        }
        return state.sub;
      },
      upsert: async ({ update }: any) => {
        state.sub = { ...state.sub, ...update };
        return state.sub;
      },
      update: async ({ data }: any) => {
        state.sub = { ...state.sub, ...data };
        return state.sub;
      },
    },
  };
  const svc = new SubscriptionsService(
    prisma,
    { get: () => undefined } as any,
    {} as any,
  );
  if (opts.stripe) {
    (svc as any).stripe = opts.stripe;
  }
  return { svc, state };
}

describe("resyncFromStripe", () => {
  it("refuses a location outside the caller's allowlist", async () => {
    const { svc } = makeService({ userLocations: ["some-other-location"] });
    await expect(
      svc.resyncFromStripe(TENANT_ID, LOCATION_ID, "u1", "OWNER"),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses when Stripe isn't configured", async () => {
    const { svc } = makeService({});
    await expect(
      svc.resyncFromStripe(TENANT_ID, LOCATION_ID, "u1", "PLATFORM_ADMIN"),
    ).rejects.toThrow(/stripe/i);
  });

  it("refuses when the row has no Stripe subscription id yet", async () => {
    const { svc } = makeService({
      sub: { id: "s2", tenantId: TENANT_ID, locationId: LOCATION_ID },
      stripe: {},
    });
    await expect(
      svc.resyncFromStripe(TENANT_ID, LOCATION_ID, "u1", "PLATFORM_ADMIN"),
    ).rejects.toThrow(/nothing to resync/i);
  });

  it("pulls the live subscription + invoice status and mirrors both onto the row", async () => {
    const stripe = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: "sub_stripe_1",
          customer: "cus_1",
          status: "active",
          currency: "gbp",
          items: { data: [{ price: { id: "price_1", unit_amount: 6000 } }] },
          metadata: { tenantId: TENANT_ID, locationId: LOCATION_ID },
          latest_invoice: { subscription: "sub_stripe_1", status: "paid" },
        }),
      },
      customers: {
        retrieve: jest.fn().mockResolvedValue({
          invoice_settings: { default_payment_method: null },
        }),
      },
    };
    const { svc, state } = makeService({ stripe });

    const before = state.sub;
    await svc.resyncFromStripe(TENANT_ID, LOCATION_ID, "u1", "PLATFORM_ADMIN");

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      "sub_stripe_1",
      { expand: ["latest_invoice"] },
    );
    // syncFromStripeSubscription upserted — status should now read "active"
    expect(state.sub.status).toBe("active");
    // syncFromStripeInvoice ran off the expanded latest_invoice
    expect(state.sub.lastInvoiceStatus).toBe("paid");
    expect(state.sub).not.toBe(before);
  });
});
