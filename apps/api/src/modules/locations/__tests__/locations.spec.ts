import {
  slugifyName,
  buildOnlineOrderingUrl,
  emptyOpeningHours,
  copyDayToDays,
  isOpenAt,
  customerTotalWithFee,
  applicationFeeAmount,
  merchantPayout,
} from "../locations.service";

// Phase AN — pure-function tests for the Locations service. Covers slug
// normalisation, opening-hours edits + open/closed calc, and the three
// Stripe fee math helpers per the spec's payment rules.

describe("slugifyName", () => {
  it("lowercases + dashes + drops punctuation", () => {
    expect(slugifyName("KLO – Consett (#1)")).toBe("klo-consett-1");
  });
  it("collapses repeated whitespace", () => {
    expect(slugifyName("  Pizza   Uno  ")).toBe("pizza-uno");
  });
  it("falls back when name is empty", () => {
    expect(slugifyName("")).toBe("location");
    expect(slugifyName("***")).toBe("location");
  });
  it("caps length at 60 chars", () => {
    expect(slugifyName("a".repeat(80)).length).toBeLessThanOrEqual(60);
  });
});

describe("buildOnlineOrderingUrl", () => {
  it("uses APP_URL when set", () => {
    process.env.APP_URL = "https://shop.example.com";
    expect(buildOnlineOrderingUrl("klo-consett")).toBe(
      "https://shop.example.com/order/klo-consett",
    );
  });
  it("strips a trailing slash on the base", () => {
    process.env.APP_URL = "https://shop.example.com/";
    expect(buildOnlineOrderingUrl("klo")).toBe("https://shop.example.com/order/klo");
  });
});

describe("openingHours helpers", () => {
  it("emptyOpeningHours seeds 7 disabled days", () => {
    const h = emptyOpeningHours();
    expect(Object.keys(h)).toHaveLength(7);
    expect(Object.values(h).every((d) => !d.enabled)).toBe(true);
  });

  it("copyDayToDays mirrors source schedule", () => {
    const h = emptyOpeningHours();
    h.monday = { enabled: true, slots: [{ from: "16:00", to: "23:30" }] };
    const out = copyDayToDays(h, "monday", ["tuesday", "wednesday"]);
    expect(out.tuesday.enabled).toBe(true);
    expect(out.tuesday.slots).toEqual([{ from: "16:00", to: "23:30" }]);
    expect(out.wednesday).toEqual(out.tuesday);
    // Source unchanged
    expect(out.monday.slots).toEqual([{ from: "16:00", to: "23:30" }]);
    // Untouched day stays disabled
    expect(out.thursday.enabled).toBe(false);
  });

  it("copyDayToDays produces a deep copy (mutating target does not affect source)", () => {
    const h = emptyOpeningHours();
    h.monday = { enabled: true, slots: [{ from: "10:00", to: "20:00" }] };
    const out = copyDayToDays(h, "monday", ["tuesday"]);
    out.tuesday.slots[0]!.from = "12:00";
    expect(h.monday.slots[0]!.from).toBe("10:00");
  });

  it("isOpenAt true within slot, false outside", () => {
    const h = emptyOpeningHours();
    h.monday = { enabled: true, slots: [{ from: "16:00", to: "22:00" }] };
    // Monday 2026-06-01 — 2026-06-01 is a Monday
    expect(isOpenAt(h, new Date("2026-06-01T18:00:00"))).toBe(true);
    expect(isOpenAt(h, new Date("2026-06-01T12:00:00"))).toBe(false);
    expect(isOpenAt(h, new Date("2026-06-01T22:30:00"))).toBe(false);
  });

  it("isOpenAt returns false when disabled or hours missing", () => {
    const h = emptyOpeningHours();
    expect(isOpenAt(h, new Date())).toBe(false);
    expect(isOpenAt(null, new Date())).toBe(false);
  });

  it("isOpenAt handles slot wrapping past midnight", () => {
    const h = emptyOpeningHours();
    // Friday 22:00 → 02:00 Saturday
    h.friday = { enabled: true, slots: [{ from: "22:00", to: "02:00" }] };
    // 2026-06-05 is a Friday (Mon=Jun 1)
    expect(isOpenAt(h, new Date("2026-06-05T23:30:00"))).toBe(true);
    expect(isOpenAt(h, new Date("2026-06-05T21:30:00"))).toBe(false);
  });
});

describe("Stripe fee math", () => {
  // Phase AN spec examples:
  //   Fixed £0.50 on £10 → customer pays £10.50, app fee £0.50.
  //   Percent 5% on £10  → customer pays £10.00, app fee £0.50, merchant £9.50.

  it("fixed fee adds to customer bill", () => {
    expect(customerTotalWithFee(10, { mode: "fixed_only", fixed: 0.5 })).toBe(10.5);
    expect(applicationFeeAmount(10, { mode: "fixed_only", fixed: 0.5 })).toBe(0.5);
    expect(merchantPayout(10, { mode: "fixed_only", fixed: 0.5 })).toBe(10);
  });

  it("percentage fee is deducted from merchant payout, NOT customer", () => {
    expect(customerTotalWithFee(10, { mode: "percentage_only", percentage: 5 })).toBe(10);
    expect(applicationFeeAmount(10, { mode: "percentage_only", percentage: 5 })).toBe(0.5);
    expect(merchantPayout(10, { mode: "percentage_only", percentage: 5 })).toBe(9.5);
  });

  it("fixed_and_percentage combines both rules", () => {
    const cfg = { mode: "fixed_and_percentage" as const, fixed: 0.5, percentage: 5 };
    expect(customerTotalWithFee(10, cfg)).toBe(10.5);
    // App fee = fixed 0.50 + percent 0.50 = 1.00 — taken at the
    // PaymentIntent split; merchant payout = 10 - 0.50% = 9.50
    expect(applicationFeeAmount(10, cfg)).toBe(1);
    expect(merchantPayout(10, cfg)).toBe(9.5);
  });

  it("mode=none is a no-op", () => {
    const cfg = { mode: "none" as const, fixed: 1, percentage: 10 };
    expect(customerTotalWithFee(10, cfg)).toBe(10);
    expect(applicationFeeAmount(10, cfg)).toBe(0);
    expect(merchantPayout(10, cfg)).toBe(10);
  });
});
