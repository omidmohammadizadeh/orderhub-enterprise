import { brandOverrideServesLocation } from "../ordering.service";

// `?brand=` REPLACES the storefront's menu and the shop's name.
//
// Best Kebab's receipt QR opened China Chef's menu under the name "Order Hub"
// because a brand id in the URL was loaded with `findUnique({ id })` — no
// check that the brand had anything to do with that location, and none that it
// belonged to the same tenant.
//
// Fixing the QR builder fixed one caller. This is the primitive underneath it:
// any link anywhere — a campaign, an SMS, a printed flyer, a guessed URL —
// could point a customer at another shop's menu, prices and Stripe account.
// So the storefront itself now refuses a brand this location doesn't serve.
describe("storefront ?brand= override", () => {
  const LOCATION = { id: "loc-1", brandId: "brand-shop" };

  it("accepts the location's own brand", () => {
    expect(
      brandOverrideServesLocation({
        location: LOCATION,
        brand: { id: "brand-shop" },
      }),
    ).toBe(true);
  });

  it("accepts a virtual brand whose primary location is this shop", () => {
    expect(
      brandOverrideServesLocation({
        location: LOCATION,
        brand: { id: "brand-virtual", primaryLocationId: "loc-1" },
      }),
    ).toBe(true);
  });

  it("accepts a brand that lists this shop among its locations", () => {
    // A kitchen running several virtual brands — the legitimate case for
    // ?brand= existing at all.
    expect(
      brandOverrideServesLocation({
        location: LOCATION,
        brand: { id: "brand-multi", locationIds: ["loc-9", "loc-1"] },
      }),
    ).toBe(true);
  });

  it("REFUSES a brand that has nothing to do with this shop", () => {
    expect(
      brandOverrideServesLocation({
        location: LOCATION,
        brand: {
          id: "brand-elsewhere",
          primaryLocationId: "loc-999",
          locationIds: ["loc-999"],
        },
      }),
    ).toBe(false);
  });

  it("REFUSES a brand with no link to any location", () => {
    // The "Order Hub" placeholder case: it isn't the location's brand and
    // names no locations, so there is nothing tying it to this shop. Being
    // permissive here is what produced a Chinese menu at a kebab shop.
    expect(
      brandOverrideServesLocation({
        location: LOCATION,
        brand: { id: "brand-placeholder" },
      }),
    ).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(
      brandOverrideServesLocation({ location: LOCATION, brand: null }),
    ).toBe(false);
  });
});
