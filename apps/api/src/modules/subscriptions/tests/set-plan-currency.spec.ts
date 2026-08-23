import { subscriptionCurrency } from "../subscriptions.service";

// Subscriptions bill in the shop's own currency, not a hardcoded "gbp".
//
// A Dubai merchant billed in sterling pays their bank's foreign-transaction fee
// on top and watches the amount move every month with the exchange rate. Stripe
// presents any currency on our UK account and still settles us in GBP, so this
// needs no second Stripe account and no UAE entity.

describe("subscriptionCurrency", () => {
  it("uses the location's own currency when it has one", () => {
    expect(subscriptionCurrency({ currency: "AED", country: "AE" })).toBe("aed");
  });

  it("falls back to whatever the country trades in", () => {
    expect(subscriptionCurrency({ currency: null, country: "AE" })).toBe("aed");
    expect(subscriptionCurrency({ currency: null, country: "KW" })).toBe("kwd");
  });

  it("leaves a UK shop exactly as it was", () => {
    // The regression that matters: every existing subscription is GBP and must
    // stay GBP. Stripe cannot change a live subscription's currency.
    expect(subscriptionCurrency({ currency: "GBP", country: "GB" })).toBe("gbp");
    expect(subscriptionCurrency({ currency: null, country: "GB" })).toBe("gbp");
    expect(subscriptionCurrency({})).toBe("gbp");
  });

  it("lowercases, because Stripe requires it", () => {
    expect(subscriptionCurrency({ currency: "AED" })).toBe("aed");
  });
});
