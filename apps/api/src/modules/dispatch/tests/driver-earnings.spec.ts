import { creditedOn, creditedStopsIn, isCashPayment, matchPostcodeFee, normalizePostcode, stopPostcode, summariseStops } from "../driver-earnings.service";

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

describe("when a stop counts towards pay", () => {
  const at = new Date("2026-11-01T18:00:00Z");
  const later = new Date("2026-11-01T20:00:00Z");

  it("counts a normal stop only once delivered", () => {
    expect(creditedOn({ status: "ASSIGNED" as any })).toBeNull();
    expect(creditedOn({ status: "PICKED_UP" as any })).toBeNull();
    expect(creditedOn({ status: "DELIVERED" as any, deliveredAt: later })).toBe(later);
  });

  it("counts a credited stop from dispatch, even if never started", () => {
    expect(creditedOn({ status: "ASSIGNED" as any, creditedAt: at })).toBe(at);
    expect(creditedOn({ status: "PICKED_UP" as any, creditedAt: at })).toBe(at);
  });

  // The stop must keep its one counting moment, or a cash-up settled between
  // dispatch and delivery would pay it twice.
  it("keeps the dispatch moment when a credited stop is delivered later", () => {
    expect(creditedOn({ status: "DELIVERED" as any, creditedAt: at, deliveredAt: later })).toBe(at);
  });

  it("drops a credited stop that was cancelled or returned to the board", () => {
    expect(creditedOn({ status: "CANCELLED" as any, creditedAt: at })).toBeNull();
  });

  it("selects credited stops by creditedAt and the rest by deliveredAt", () => {
    const range = { gt: at, lte: later };
    const { OR } = creditedStopsIn(range) as any;
    expect(OR[0].creditedAt).toBe(range);
    expect(OR[0].status.in).not.toContain("CANCELLED");
    expect(OR[1]).toMatchObject({ creditedAt: null, status: "DELIVERED", deliveredAt: range });
  });
});

describe("summariseStops", () => {
  const driver = { startupFee: "10", postcodeFees: [{ postcode: "B1", fee: 3 }] };
  const stop = (total: number, paymentMethod: string, deliveredAt: string) => ({
    status: "DELIVERED" as any,
    deliveredAt: new Date(deliveredAt),
    order: { total, paymentMethod, postcode: "B1 2HF" },
  });

  // A fully cashed-up driver has no stops left in their period, and the card
  // the operator looks at has to read zero, not today's takings.
  it("is all zero with nothing outstanding", () => {
    expect(summariseStops(driver, [])).toMatchObject({
      deliveries: 0,
      cashCollected: 0,
      cardCollected: 0,
      driverEarning: 0,
      cashHandover: 0,
    });
  });

  it("charges the start-up fee once per day worked", () => {
    const owed = summariseStops(driver, [
      stop(20, "CASH", "2026-11-01T18:00:00Z"),
      stop(5, "CARD", "2026-11-01T19:00:00Z"),
      stop(10, "CASH", "2026-11-02T18:00:00Z"),
    ]);
    expect(owed).toMatchObject({
      deliveries: 3,
      cashCollected: 30,
      cardCollected: 5,
      daysWorked: 2,
      startupFeeTotal: 20,
      deliveryFeeTotal: 9,
      driverEarning: 29,
      cashHandover: 1,
    });
  });
});

describe("delivery fees on website and marketplace orders", () => {
  // Reported at Kingston Pizza: a driver with NE3/NE5/... fees earned only the
  // start-up fee, because these orders leave the postcode column empty and
  // carry the postcode inside deliveryAddress.
  const driver = { startupFee: "30", postcodeFees: [{ postcode: "NE3", fee: 2.5 }, { postcode: "NE5", fee: 3 }] };
  const blobOrder = (postcode: string) => ({
    status: "DELIVERED" as any,
    deliveredAt: new Date("2026-11-01T18:00:00Z"),
    order: {
      total: 28.04,
      paymentMethod: "CARD",
      postcode: null,
      deliveryAddress: { line1: "3 Darwin Crescent", city: "newcastle upon tyne", postcode },
    },
  });

  it("finds the postcode inside the address blob", () => {
    expect(stopPostcode({ postcode: null, deliveryAddress: { postcode: "ne3 4tt" } })).toBe("ne3 4tt");
    expect(stopPostcode({ postcode: "NE5 1AA", deliveryAddress: null })).toBe("NE5 1AA");
  });

  it("pays the postcode fee on them", () => {
    const owed = summariseStops(driver, [blobOrder("ne3 4tt"), blobOrder("NE5 2BB")]);
    expect(owed.deliveryFeeTotal).toBe(5.5);
    expect(owed.driverEarning).toBe(35.5);
  });
});
