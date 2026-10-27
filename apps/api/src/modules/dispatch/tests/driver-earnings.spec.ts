import { isCashPayment, matchPostcodeFee, normalizePostcode } from "../driver-earnings.service";

describe("isCashPayment", () => {
  it("counts every cash spelling as cash", () => {
    for (const m of ["CASH", "cash", "CASH_ON_DELIVERY", "COD"]) {
      expect(isCashPayment(m)).toBe(true);
    }
  });

  // The settlement has always treated an order with no method as cash; the
  // driver app used to call it card, so the driver's screen and the cash-up
  // they were settled on disagreed by that order's total.
  it("counts a missing payment method as cash, like the settlement", () => {
    expect(isCashPayment(null)).toBe(true);
    expect(isCashPayment(undefined)).toBe(true);
    expect(isCashPayment("")).toBe(true);
  });

  it("does not count card or wallet payments", () => {
    for (const m of ["CARD", "APPLE_PAY", "GOOGLE_PAY", "VOUCHER"]) {
      expect(isCashPayment(m)).toBe(false);
    }
  });
});

describe("postcode fees", () => {
  it("normalises spacing and case", () => {
    expect(normalizePostcode(" b1 2hf ")).toBe("B12HF");
  });

  it("prefers the longest matching prefix", () => {
    const rules = [
      { postcode: "B1", fee: 3 },
      { postcode: "B12", fee: 5 },
    ];
    expect(matchPostcodeFee(rules, "B12 9QR")).toBe(5);
    expect(matchPostcodeFee(rules, "B1 2HF")).toBe(3);
    expect(matchPostcodeFee(rules, "CV1 1AA")).toBe(0);
  });

  // "B1 2HF" loses its space to "B12HF", which a plain prefix test read as
  // district B12 — a B1 delivery was paid at the B12 rate.
  it("never reads district B1 as B12 once the space is gone", () => {
    expect(matchPostcodeFee([{ postcode: "B12", fee: 5 }], "B1 2HF")).toBe(0);
    expect(matchPostcodeFee([{ postcode: "B12", fee: 5 }], "B12HF")).toBe(0);
    expect(matchPostcodeFee([{ postcode: "B1", fee: 3 }], "B12 9QR")).toBe(0);
  });

  it("lets a letters-only area cover its districts but not a longer area", () => {
    const rules = [{ postcode: "B", fee: 2 }];
    expect(matchPostcodeFee(rules, "B12 9QR")).toBe(2);
    expect(matchPostcodeFee(rules, "B1 2HF")).toBe(2);
    expect(matchPostcodeFee(rules, "BS1 4DJ")).toBe(0);
  });

  it("still matches sector rules and postcodes stored without the inward code", () => {
    expect(matchPostcodeFee([{ postcode: "B12 9", fee: 6 }], "B12 9QR")).toBe(6);
    expect(matchPostcodeFee([{ postcode: "B12 9", fee: 6 }], "B12 8AA")).toBe(0);
    expect(matchPostcodeFee([{ postcode: "B1", fee: 3 }], "b1")).toBe(3);
    expect(matchPostcodeFee([{ postcode: "SW1A", fee: 4 }], "SW1A 1AA")).toBe(4);
  });
});
