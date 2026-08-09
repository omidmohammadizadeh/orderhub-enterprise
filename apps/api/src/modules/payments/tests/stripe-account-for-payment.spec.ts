import { PaymentsService } from "../payments.service";

// stripeAccountForPayment resolves which connected account a follow-up
// Stripe call (refund / cancel / terminal poll) must target.
//
// Online orders and WisePad 3 / Tap to Pay charges (metadata.channel ===
// "mobile_reader") resolve WITH the order's brandId, so a brand's own
// escape-hatch acct_… (pasted directly on the Brand settings drawer) wins —
// that's how a virtual brand at a shared kitchen routes its own payouts, and
// how a mobile SDK session opened per-order stays on the SAME account as the
// PaymentIntent it confirms.
//
// The S700 counter reader is the opposite: it's registered ONCE and reused
// across many later orders/brands, so it's fixed at the LOCATION level (no
// brandId). Re-resolving WITH brandId here for an S700 Payment would land on
// a brand's escape-hatch account — DIFFERENT from the one the reader/PI
// actually live on — so refund, cancel, and the terminal poll endpoint
// would 404 against the wrong account. This is pinned so regression can't
// creep back into either direction.

const TENANT = "t1";

function makeService() {
  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = {
    stripeConnectAccount: {
      findUnique: async () => null,
      findFirst: async ({ where }: any) => {
        if (where.locationId === "loc1" && where.locationId !== null) {
          return { id: "row-loc", stripeAccountId: "acct_location" };
        }
        return null;
      },
    },
    order: {
      findUnique: async () => ({
        tenantId: TENANT,
        locationId: "loc1",
        brandId: "brand-vegan",
      }),
    },
    brand: {
      findUnique: async () => ({ stripeConnectedAccountId: "acct_brand_vegan" }),
    },
    location: {
      findUnique: async () => ({ stripeConnectedAccountId: null }),
    },
  };
  return svc as PaymentsService;
}

describe("stripeAccountForPayment", () => {
  it("honours the order's brandId for an online (non-terminal) payment — brand escape-hatch wins", async () => {
    const svc = makeService();
    const account = await svc.stripeAccountForPayment({
      orderId: "o1",
      metadata: {},
    });
    expect(account).toBe("acct_brand_vegan");
  });

  it("ignores brandId for an S700 payment (no channel) — resolves the location-level account instead", async () => {
    const svc = makeService();
    const account = await svc.stripeAccountForPayment({
      orderId: "o1",
      metadata: { source: "terminal" },
    });
    expect(account).toBe("acct_location");
  });

  it("honours brandId for a mobile-reader (WisePad 3 / Tap to Pay) payment — brand escape-hatch wins", async () => {
    const svc = makeService();
    const account = await svc.stripeAccountForPayment({
      orderId: "o1",
      metadata: { source: "terminal", channel: "mobile_reader" },
    });
    expect(account).toBe("acct_brand_vegan");
  });

  it("uses the FK-linked StripeConnectAccount row directly when present, skipping order lookup entirely", async () => {
    const svc = makeService();
    svc.prisma.stripeConnectAccount.findUnique = async () => ({
      stripeAccountId: "acct_fk",
    });
    let orderLookedUp = false;
    svc.prisma.order.findUnique = async () => {
      orderLookedUp = true;
      return null;
    };
    const account = await svc.stripeAccountForPayment({
      orderId: "o1",
      stripeConnectAccountId: "row-1",
      metadata: { source: "terminal" },
    });
    expect(account).toBe("acct_fk");
    expect(orderLookedUp).toBe(false);
  });
});
