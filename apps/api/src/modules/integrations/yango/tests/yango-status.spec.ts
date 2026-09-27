import {
  offerVerdict,
  YANGO_CANCELLED_ELSEWHERE,
  YANGO_FAILED_BY_YANGO,
  YANGO_STATUS_MAP,
  YANGO_TERMINAL,
} from "../yango-status";

describe("status map", () => {
  it("does NOT tell the customer a rider is coming while Yango is still searching", () => {
    for (const s of ["new", "estimating", "ready_for_approval", "accepted", "performer_lookup", "performer_draft"]) {
      expect(YANGO_STATUS_MAP[s]).toBeNull();
    }
    expect(YANGO_STATUS_MAP.performer_found).toBe("ASSIGNED_DRIVER");
  });

  it("the food leaving the shop is OUT_FOR_DELIVERY; the single hand-over completes", () => {
    expect(YANGO_STATUS_MAP.pickuped).toBe("OUT_FOR_DELIVERY");
    expect(YANGO_STATUS_MAP.delivered).toBe("COMPLETED");
    expect(YANGO_STATUS_MAP.delivered_finish).toBe("COMPLETED");
  });

  it("returns never move the order — refunding is a person's call", () => {
    for (const s of ["returning", "return_arrived", "returned", "returned_finish"]) {
      expect(YANGO_STATUS_MAP[s]).toBeNull();
    }
  });

  it("an unknown status (pay_waiting is documented but missing from the enum) is tolerated", () => {
    expect(YANGO_STATUS_MAP["something_new"] ?? null).toBeNull();
  });

  it("every failure/cancel status is terminal, so the poller stops asking", () => {
    for (const s of [...YANGO_FAILED_BY_YANGO, ...YANGO_CANCELLED_ELSEWHERE]) {
      expect(YANGO_TERMINAL.has(s)).toBe(true);
    }
  });

  it("a cancel from the shop's cabinet is not treated as Yango's failure (no refund loop)", () => {
    expect(YANGO_FAILED_BY_YANGO.has("cancelled")).toBe(false);
    expect(YANGO_CANCELLED_ELSEWHERE.has("cancelled")).toBe(true);
  });
});

describe("offerVerdict — whether a real courier gets booked", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const later = "2026-09-27T12:05:00+00:00";

  it("accepts an offer at the quote", () => {
    expect(offerVerdict({ offerPrice: 20, quotedPrice: 20, validUntil: later, now, drift: 0.25 })).toEqual({ ok: true });
  });
  it("accepts up to the drift cap, inclusive", () => {
    expect(offerVerdict({ offerPrice: 25, quotedPrice: 20, validUntil: later, now, drift: 0.25 }).ok).toBe(true);
  });
  it("refuses past the drift cap", () => {
    expect(offerVerdict({ offerPrice: 25.01, quotedPrice: 20, validUntil: later, now, drift: 0.25 })).toEqual({
      ok: false,
      reason: "too_expensive",
    });
  });
  it("refuses an expired offer — accepting one returns 200 and then the claim fails", () => {
    expect(
      offerVerdict({ offerPrice: 10, quotedPrice: 20, validUntil: "2026-09-27T11:59:59Z", now }),
    ).toEqual({ ok: false, reason: "expired" });
  });
  it("refuses an offer with no price", () => {
    expect(offerVerdict({ offerPrice: null, quotedPrice: 20, validUntil: later, now }).ok).toBe(false);
  });
  it("with no quote to compare, a priced unexpired offer is accepted", () => {
    expect(offerVerdict({ offerPrice: 99, quotedPrice: null, validUntil: later, now }).ok).toBe(true);
  });
  it("reads YANGO_MAX_PRICE_DRIFT when no drift is passed", () => {
    process.env.YANGO_MAX_PRICE_DRIFT = "0";
    try {
      expect(offerVerdict({ offerPrice: 20.5, quotedPrice: 20, validUntil: later, now }).ok).toBe(false);
    } finally {
      delete process.env.YANGO_MAX_PRICE_DRIFT;
    }
  });
});
