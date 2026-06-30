import {
  normalizePricingVariants,
  buildHubRisePriceOverrides,
  CHANNEL_VARIANT_PRESETS,
} from "@orderhub/shared";

// Pure-function tests for the pricing-variant helpers that drive the
// HubRise publish (one menu → per-channel/brand prices).

describe("normalizePricingVariants", () => {
  it("keeps valid variants, drops junk + dupes", () => {
    const out = normalizePricingVariants([
      { ref: "UBER_EATS", name: "Uber Eats", channelKey: "UBER_EATS" },
      { ref: "UBER_EATS", name: "dup" }, // dropped (dupe ref)
      { ref: "", name: "no ref" }, // dropped
      { ref: "var_x", name: "" }, // dropped (no name)
      { ref: "var_kiosk", name: "Kiosk" },
      "garbage",
      null,
    ] as any);
    expect(out).toEqual([
      { ref: "UBER_EATS", name: "Uber Eats", channelKey: "UBER_EATS" },
      { ref: "var_kiosk", name: "Kiosk" },
    ]);
  });

  it("returns [] for non-arrays", () => {
    expect(normalizePricingVariants(undefined)).toEqual([]);
    expect(normalizePricingVariants({} as any)).toEqual([]);
  });
});

describe("buildHubRisePriceOverrides", () => {
  const fmt = (n: number) => `${n.toFixed(2)} GBP`;
  const refs = new Set(["UBER_EATS", "DELIVEROO"]);

  it("emits a rule per in-scope variant, skipping unknown refs", () => {
    const rules = buildHubRisePriceOverrides(
      { UBER_EATS: 11.99, DELIVEROO: 10.5, JUST_EAT: 9.99 },
      refs,
      9.99,
      fmt,
    );
    expect(rules).toEqual([
      { variant_refs: ["UBER_EATS"], price: "11.99 GBP" },
      { variant_refs: ["DELIVEROO"], price: "10.50 GBP" },
    ]);
  });

  it("drops overrides equal to the default price and invalid amounts", () => {
    const rules = buildHubRisePriceOverrides(
      { UBER_EATS: 9.99, DELIVEROO: -1 },
      refs,
      9.99,
      fmt,
    );
    expect(rules).toEqual([]);
  });

  it("returns [] when no overrides", () => {
    expect(buildHubRisePriceOverrides(undefined, refs, 5, fmt)).toEqual([]);
    expect(buildHubRisePriceOverrides({}, refs, 5, fmt)).toEqual([]);
  });
});

describe("CHANNEL_VARIANT_PRESETS", () => {
  it("refs equal channel keys so existing per-channel prices map straight on", () => {
    for (const p of CHANNEL_VARIANT_PRESETS) expect(p.ref).toBe(p.channelKey);
  });
});
