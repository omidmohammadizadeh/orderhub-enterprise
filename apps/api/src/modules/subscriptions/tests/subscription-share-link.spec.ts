import { BadRequestException } from "@nestjs/common";
import { SubscriptionsService } from "../subscriptions.service";

// A link the merchant can send to the client.
//
// "Add card" opens a Stripe Checkout session in the operator's own browser,
// which is no use when the person with the card is the client. The obvious
// shortcut — copy that Stripe URL and email it — breaks quietly: a Checkout
// session expires after 24 hours, so the client clicks it two days later and
// gets an error page.
//
// So the shareable link is OURS and stable. Opening it mints a FRESH Stripe
// session every time, which means it still works next week. It carries a
// signed, expiring token rather than a location id, so it can't be guessed or
// pointed at another shop's subscription.
const SECRET = "test-signing-secret";
const LOCATION_ID = "loc-1";

function makeService(opts: { sub?: any; stripe?: any } = {}) {
  const svc: any = Object.create(SubscriptionsService.prototype);
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  svc.config = {
    get: (k: string) =>
      k === "WEB_URL"
        ? "https://www.orderhubsolutions.com"
        : k === "JWT_SECRET"
          ? SECRET
          : undefined,
  };
  svc.prisma = {
    merchantSubscription: {
      findFirst: jest.fn().mockResolvedValue(
        opts.sub === undefined
          ? {
              id: "row-1",
              tenantId: "t1",
              locationId: LOCATION_ID,
              status: "incomplete",
              stripeCustomerId: "cus_1",
              stripePriceId: "price_1",
              location: { id: LOCATION_ID, name: "GRILLSHACK" },
            }
          : opts.sub,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  svc.stripe =
    opts.stripe ??
    {
      checkout: {
        sessions: {
          create: jest
            .fn()
            .mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
        },
      },
    };
  svc.assertLocationAccess = jest.fn().mockResolvedValue(undefined);
  return svc;
}

const tokenFrom = (url: string) => url.split("/subscribe/")[1]!;

describe("SubscriptionsService — shareable subscription link", () => {
  it("mints a link on our own domain, not a Stripe URL that expires", async () => {
    const svc = makeService();

    const { url } = await svc.subscriptionShareLink("t1", LOCATION_ID, "u1", "OWNER");

    expect(url).toContain("https://www.orderhubsolutions.com/subscribe/");
    expect(url).not.toContain("checkout.stripe.com");
    // The location id must not be readable from the link.
    expect(url).not.toContain(LOCATION_ID);
  });

  it("opens a FRESH Stripe session each time the link is used", async () => {
    const svc = makeService();
    const { url } = await svc.subscriptionShareLink("t1", LOCATION_ID, "u1", "OWNER");

    const first = await svc.checkoutFromShareToken(tokenFrom(url));
    const second = await svc.checkoutFromShareToken(tokenFrom(url));

    expect(first.url).toContain("checkout.stripe.com");
    expect(second.url).toContain("checkout.stripe.com");
    expect(svc.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  it("refuses a tampered token", async () => {
    const svc = makeService();
    const { url } = await svc.subscriptionShareLink("t1", LOCATION_ID, "u1", "OWNER");
    const tampered = tokenFrom(url).replace(/.$/, (c) => (c === "A" ? "B" : "A"));

    await expect(svc.checkoutFromShareToken(tampered)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(svc.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a token that has expired", async () => {
    const svc = makeService();
    const expired = svc.signShareToken(LOCATION_ID, Math.floor(Date.now() / 1000) - 60);

    await expect(svc.checkoutFromShareToken(expired)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(svc.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("says the subscription is already paid for rather than taking a second card", async () => {
    const svc = makeService({
      sub: {
        id: "row-1",
        tenantId: "t1",
        locationId: LOCATION_ID,
        status: "active",
        stripeCustomerId: "cus_1",
        stripePriceId: "price_1",
        location: { id: LOCATION_ID, name: "GRILLSHACK" },
      },
    });
    const { url } = await svc.subscriptionShareLink("t1", LOCATION_ID, "u1", "OWNER");

    await expect(svc.checkoutFromShareToken(tokenFrom(url))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
