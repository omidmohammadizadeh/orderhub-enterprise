import { PaymentsService } from "../payments.service";

// stripeAccountForPayment resolves which connected account a follow-up
// Stripe call (refund / cancel / terminal poll) must target.
//
// Online orders resolve WITH the order's brandId, so a brand's own
// escape-hatch acct_… (pasted directly on the Brand settings drawer) wins —
// that's how a virtual brand at a shared kitchen routes its own payouts.
//
// Terminal charges (S700 / WisePad 3 / Tap to Pay) are the opposite: a
// physical reader or an SDK connection session is fixed to ONE account,
// resolved at the LOCATION level (TerminalService never passes brandId
// when creating the PaymentIntent). Re-resolving WITH brandId here for a
// terminal Payment would land on the brand's escape-hatch account —
// DIFFERENT from the one the PaymentIntent actually lives on — so refund,
// cancel, and the terminal poll endpoint would 404 against the wrong
// account. This is pinned so that regression can't creep back in.

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

  it("ignores brandId for a terminal payment — resolves the location-level account instead", async () => {
    const svc = makeService();
    const account = await svc.stripeAccountForPayment({
      orderId: "o1",
      metadata: { source: "terminal" },
    });
    expect(account).toBe("acct_location");
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
