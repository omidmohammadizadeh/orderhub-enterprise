// Which record decides the customer's service charge — brand or location.
//
// Two places answer this: the storefront payload (what the cart SHOWS) and
// computeFeeBreakdownPence (what the card is DEBITED). They have to agree.
// They didn't: the storefront used `??`, which only falls through on null, so
// a brand explicitly set to "none" over a location charging a fixed fee showed
// no service charge and then took it anyway. A £1.80 cart debited £2.30.
//
// The rule is pinned here rather than left to inspection because the failure
// is invisible in code review and only shows up as a customer being charged
// more than the screen said.

/** The payment side's rule, from PaymentsService.createStorefrontPaymentIntent. */
function paymentFeeSource(brand: any, location: any) {
  return brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
    ? brand
    : location;
}

/** The storefront payload's rule, from OrderingService.getStorefrontBySlug. */
function storefrontFeeSource(brand: any, location: any) {
  return brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
    ? brand
    : location;
}

const BRAND_FEE = { applicationFeeMode: "fixed_only", applicationFeeFixedAmount: 0.75 };
const LOC_FEE = { applicationFeeMode: "fixed_only", applicationFeeFixedAmount: 0.5 };
const NONE = { applicationFeeMode: "none", applicationFeeFixedAmount: 0 };

describe("service-charge fee source", () => {
  const agree = (brand: any, location: any) => {
    const shown = storefrontFeeSource(brand, location);
    const charged = paymentFeeSource(brand, location);
    expect(shown).toBe(charged);
    return shown;
  };

  it("falls through to the location when the brand is explicitly none", () => {
    // The regression. `??` kept the brand's "none" and hid a real fee.
    expect(agree(NONE, LOC_FEE)).toBe(LOC_FEE);
  });

  it("falls through to the location when the brand sets nothing at all", () => {
    expect(agree(null, LOC_FEE)).toBe(LOC_FEE);
    expect(agree({ applicationFeeMode: null }, LOC_FEE)).toBe(LOC_FEE);
  });

  it("lets a brand with its own fee override the location", () => {
    expect(agree(BRAND_FEE, LOC_FEE)).toBe(BRAND_FEE);
  });

  it("charges nothing when neither charges anything", () => {
    expect(agree(NONE, NONE)).toBe(NONE);
  });

  it("never pairs one record's mode with the other's amount", () => {
    // Reading mode and amount from different records was the second half of
    // the same bug: a brand mode of fixed_only with a location amount.
    const source = agree(NONE, LOC_FEE) as any;
    expect(source.applicationFeeMode).toBe("fixed_only");
    expect(source.applicationFeeFixedAmount).toBe(0.5);
  });
});
