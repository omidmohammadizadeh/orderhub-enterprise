import { resolveUnpinnedBrandId } from "../ordering.service";

// Order #JWDBH (pizza uno pelton) printed "Order Hub" as the shop name and
// found no delivery zones. Location.brandId still pointed at an orphaned
// brand left behind by a deleted location, while the brand actually trading
// there — the one the Brands drawer lists via primaryLocationId — was a
// different row entirely.

describe("resolveUnpinnedBrandId", () => {
  it("keeps the stored brand when it is healthy", () => {
    expect(
      resolveUnpinnedBrandId({
        locationBrandId: "brand-real",
        locationBrandIsOrphan: false,
        operatingBrandIds: ["brand-other"],
      }),
    ).toBe("brand-real");
  });

  it("uses the operating brand when the stored one is orphaned", () => {
    expect(
      resolveUnpinnedBrandId({
        locationBrandId: "brand-orphan",
        locationBrandIsOrphan: true,
        operatingBrandIds: ["brand-pizza-uno"],
      }),
    ).toBe("brand-pizza-uno");
  });

  // Guessing between several would mis-attribute revenue and Stripe Connect
  // routing, so it deliberately changes nothing.
  it("does NOT guess when several brands operate at the location", () => {
    expect(
      resolveUnpinnedBrandId({
        locationBrandId: "brand-orphan",
        locationBrandIsOrphan: true,
        operatingBrandIds: ["brand-a", "brand-b"],
      }),
    ).toBe("brand-orphan");
  });

  it("keeps the stored brand when nothing operates at the location", () => {
    expect(
      resolveUnpinnedBrandId({
        locationBrandId: "brand-orphan",
        locationBrandIsOrphan: true,
        operatingBrandIds: [],
      }),
    ).toBe("brand-orphan");
  });
});
