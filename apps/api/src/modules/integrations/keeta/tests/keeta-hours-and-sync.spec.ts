import { KEETA_ALL_WEEK_OPEN, keetaBusinessHours } from "../keeta-hours";
import { keetaCancelCode, keetaOutboundFor } from "../keeta-order-sync.service";

const week = (over: Record<string, Array<{ from: string; to: string }>> = {}) => ({
  monday: [],
  tuesday: [],
  wednesday: [],
  thursday: [],
  friday: [],
  saturday: [],
  sunday: [],
  ...over,
});

describe("keetaBusinessHours", () => {
  it("sends seconds from midnight", () => {
    expect(keetaBusinessHours(week({ monday: [{ from: "10:00", to: "22:00" }] })).mon).toEqual([
      { startTime: 36000, endTime: 79200 },
    ]);
  });

  it("sends a closed day as 0/0, Keeta's full-day closure", () => {
    expect(keetaBusinessHours(week()).tue).toEqual([{ startTime: 0, endTime: 0 }]);
  });

  it("splits an overnight slot across two days", () => {
    const h = keetaBusinessHours(week({ friday: [{ from: "18:00", to: "02:00" }] }));
    expect(h.fri).toEqual([{ startTime: 64800, endTime: 86400 }]);
    expect(h.sat).toEqual([{ startTime: 0, endTime: 7200 }]);
  });

  it("wraps Sunday night into Monday morning", () => {
    const h = keetaBusinessHours(week({ sunday: [{ from: "20:00", to: "01:00" }] }));
    expect(h.mon).toEqual([{ startTime: 0, endTime: 3600 }]);
  });

  it("reads 00:00 as an end of midnight", () => {
    expect(keetaBusinessHours(week({ monday: [{ from: "12:00", to: "00:00" }] })).mon).toEqual([
      { startTime: 43200, endTime: 86400 },
    ]);
  });

  it("merges overlapping slots — Keeta reject overlaps", () => {
    const h = keetaBusinessHours(
      week({ monday: [{ from: "12:00", to: "15:00" }, { from: "14:00", to: "18:00" }, { from: "19:00", to: "23:00" }] }),
    );
    expect(h.mon).toEqual([
      { startTime: 43200, endTime: 64800 },
      { startTime: 68400, endTime: 82800 },
    ]);
  });

  it("merges Saturday's own morning with Friday's overnight spill", () => {
    const h = keetaBusinessHours(
      week({ friday: [{ from: "18:00", to: "02:00" }], saturday: [{ from: "01:00", to: "04:00" }] }),
    );
    expect(h.sat).toEqual([{ startTime: 0, endTime: 14400 }]);
  });

  it("has an all-week-open default for shops with no hours", () => {
    expect(KEETA_ALL_WEEK_OPEN.sun).toEqual([{ startTime: 0, endTime: 86400 }]);
  });
});

describe("keetaOutboundFor", () => {
  const rider = { pickup: false, selfDelivery: false };
  const self = { pickup: false, selfDelivery: true };
  const pickup = { pickup: true, selfDelivery: false };

  it("maps the kitchen states every order shares", () => {
    expect(keetaOutboundFor("ACCEPTED", rider)).toBe("confirm");
    expect(keetaOutboundFor("READY", rider)).toBe("prepare");
    expect(keetaOutboundFor("CANCELLED", rider)).toBe("cancel");
    expect(keetaOutboundFor("REJECTED", rider)).toBe("cancel");
    expect(keetaOutboundFor("PREPARING", rider)).toBeNull();
  });

  it("never claims a Keeta rider's delivery steps", () => {
    expect(keetaOutboundFor("OUT_FOR_DELIVERY", rider)).toBeNull();
    expect(keetaOutboundFor("COMPLETED", rider)).toBeNull();
  });

  it("reports the shop's own delivery steps", () => {
    expect(keetaOutboundFor("OUT_FOR_DELIVERY", self)).toBe("dispatched");
    expect(keetaOutboundFor("COMPLETED", self)).toBe("delivered");
  });

  it("confirms collection for pickup", () => {
    expect(keetaOutboundFor("COMPLETED", pickup)).toBe("collect");
  });
});

describe("keetaCancelCode", () => {
  it("maps staff wording onto Keeta's four codes", () => {
    expect(keetaCancelCode("Out of stock on chicken")).toEqual({ cancelCode: 500001 });
    expect(keetaCancelCode("Shop closed early")).toEqual({ cancelCode: 500002 });
    expect(keetaCancelCode("Too busy, short staffed")).toEqual({ cancelCode: 500003 });
  });

  it("uses 'other' WITH a reason — Keeta require one for 500000", () => {
    expect(keetaCancelCode("customer rang to cancel")).toEqual({
      cancelCode: 500000,
      cancelReason: "customer rang to cancel",
    });
    expect(keetaCancelCode(null)).toEqual({ cancelCode: 500000, cancelReason: "Cancelled by the restaurant" });
  });
});
