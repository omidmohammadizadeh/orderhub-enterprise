// The customer's gratuity, which goes to the RESTAURANT rather than a courier.
//
// The tip arrives from the browser, so it is an untrusted number whose only
// effect is to increase what we charge someone's card. It is clamped here
// rather than trusted, and the clamp is the thing worth pinning: the failure
// mode is billing a real customer real money they did not agree to.
//
// The maths mirrors OrderingService.checkout exactly. Exercising it through
// the service would need the whole storefront resolution — menu, campaign,
// pause state, Stripe — to answer a question about arithmetic.

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Lifted verbatim from OrderingService.checkout. */
function serverTipFor(input: {
  subtotal: number;
  discount?: number;
  deliveryFee?: number;
  tipAmount?: number;
}): number {
  const serverDiscount = round2(input.discount ?? 0);
  const goods = round2(
    input.subtotal - serverDiscount + (input.deliveryFee ?? 0),
  );
  const tipCeiling = round2(Math.max(goods * 2, 50));
  return round2(
    Math.min(Math.max(Number(input.tipAmount ?? 0) || 0, 0), tipCeiling),
  );
}

describe("checkout tip", () => {
  it("passes an ordinary tip through untouched", () => {
    expect(serverTipFor({ subtotal: 24, tipAmount: 3.6 })).toBe(3.6);
  });

  it("is zero when the customer taps Not now", () => {
    expect(serverTipFor({ subtotal: 24, tipAmount: 0 })).toBe(0);
    expect(serverTipFor({ subtotal: 24 })).toBe(0);
  });

  it("refuses a negative tip — that would discount the order", () => {
    expect(serverTipFor({ subtotal: 24, tipAmount: -10 })).toBe(0);
  });

  it("ignores a non-numeric tip rather than producing NaN", () => {
    // NaN would flow into the total and charge the customer nothing, or
    // blow up the Stripe call — either way it must never reach the maths.
    expect(serverTipFor({ subtotal: 24, tipAmount: "abc" as any })).toBe(0);
    expect(serverTipFor({ subtotal: 24, tipAmount: NaN })).toBe(0);
  });

  it("caps a tampered tip at twice the basket", () => {
    // £120 of food, someone posts a £5,000 tip. Twice the basket (240)
    // clears the £50 floor, so the proportional cap is what binds.
    expect(serverTipFor({ subtotal: 120, tipAmount: 5000 })).toBe(240);
  });

  it("uses the £50 floor when twice the basket is smaller", () => {
    // £24 of food: 2x is 48, so the floor of 50 is the higher of the two
    // and becomes the cap. Worth pinning — it's the arm that actually
    // binds on a typical takeaway order.
    expect(serverTipFor({ subtotal: 24, tipAmount: 5000 })).toBe(50);
  });

  it("still allows a generous tip on a small order", () => {
    // The floor of £50 stops the cap being absurdly tight on a £4 coffee —
    // a £10 tip on a small order is real, not an attack.
    expect(serverTipFor({ subtotal: 4, tipAmount: 10 })).toBe(10);
  });

  it("counts delivery in the basket the cap is measured against", () => {
    const tip = serverTipFor({ subtotal: 30, deliveryFee: 5, tipAmount: 80 });
    expect(tip).toBe(70); // (30 + 5) * 2
  });

  it("measures the cap after the discount, not before", () => {
    // £100 of food discounted to £10 shouldn't license a £200 tip.
    const tip = serverTipFor({ subtotal: 100, discount: 90, tipAmount: 200 });
    expect(tip).toBe(50); // max(10 * 2, 50)
  });

  it("rounds to pence", () => {
    expect(serverTipFor({ subtotal: 20, tipAmount: 3.005 })).toBe(3.01);
  });
});
