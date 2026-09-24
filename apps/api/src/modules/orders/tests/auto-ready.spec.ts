import {
  nextAutoStatus,
  readAutoReadySettings,
  type AutoReadySettings,
} from "../auto-ready";

// Auto ready marks food ready without anyone looking at it, so the rule is
// pinned hard: it only ever moves an order forward one step from the status
// before, never touches what staff already moved, and reads a scheduled
// order from the time the customer asked for.

const AT = (iso: string) => new Date(iso);
const accepted = AT("2026-09-24T12:00:00Z");

const on = (over: Partial<AutoReadySettings> = {}): AutoReadySettings => ({
  enabled: true,
  preparingAfterMinutes: 2,
  readyAfterMinutes: 15,
  scope: "MARKETPLACE",
  ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
  status: "ACCEPTED",
  acceptedAt: accepted,
  createdAt: accepted,
  orderSource: "DELIVEROO",
  platform: "DELIVEROO",
  ...over,
});

describe("readAutoReadySettings", () => {
  it("reads a configured shop", () => {
    expect(
      readAutoReadySettings({
        autoReady: { enabled: true, preparingAfterMinutes: 3, readyAfterMinutes: 12, scope: "ALL" },
      }),
    ).toEqual({
      enabled: true,
      preparingAfterMinutes: 3,
      readyAfterMinutes: 12,
      scope: "ALL",
    });
  });

  it("is off unless switched on", () => {
    expect(readAutoReadySettings({})).toBeNull();
    expect(readAutoReadySettings(null)).toBeNull();
    expect(readAutoReadySettings({ autoReady: { readyAfterMinutes: 10 } })).toBeNull();
    expect(
      readAutoReadySettings({ autoReady: { enabled: false, readyAfterMinutes: 10 } }),
    ).toBeNull();
  });

  // A half-configured timer that marks food ready is worse than none.
  it("is off when the ready time is missing or nonsense", () => {
    for (const readyAfterMinutes of [undefined, 0, -5, "soon", NaN]) {
      expect(readAutoReadySettings({ autoReady: { enabled: true, readyAfterMinutes } })).toBeNull();
    }
  });

  it("never lets preparing land after ready", () => {
    const s = readAutoReadySettings({
      autoReady: { enabled: true, preparingAfterMinutes: 30, readyAfterMinutes: 10 },
    })!;
    expect(s.preparingAfterMinutes).toBe(10);
  });

  it("keeps marketplace-only as the default scope", () => {
    const s = readAutoReadySettings({ autoReady: { enabled: true, readyAfterMinutes: 10 } })!;
    expect(s.scope).toBe("MARKETPLACE");
  });
});

describe("nextAutoStatus — the timer", () => {
  it("waits before doing anything", () => {
    expect(nextAutoStatus(order(), on(), AT("2026-09-24T12:01:00Z"))).toBeNull();
  });

  it("marks preparing, then ready, as each time passes", () => {
    expect(nextAutoStatus(order(), on(), AT("2026-09-24T12:02:00Z"))).toBe("PREPARING");
    expect(
      nextAutoStatus(order({ status: "PREPARING" }), on(), AT("2026-09-24T12:10:00Z")),
    ).toBeNull();
    expect(
      nextAutoStatus(order({ status: "PREPARING" }), on(), AT("2026-09-24T12:15:00Z")),
    ).toBe("READY");
  });

  it("goes straight to ready when both times have passed", () => {
    // An order nobody touched for half an hour shouldn't crawl a step a minute.
    expect(nextAutoStatus(order(), on(), AT("2026-09-24T12:30:00Z"))).toBe("READY");
  });

  it("leaves alone anything staff already moved on", () => {
    for (const status of ["READY", "OUT_FOR_DELIVERY", "COMPLETED", "CANCELLED", "PENDING"]) {
      expect(nextAutoStatus(order({ status }), on(), AT("2026-09-24T13:00:00Z"))).toBeNull();
    }
  });

  it("does nothing at all when the shop hasn't switched it on", () => {
    expect(nextAutoStatus(order(), null, AT("2026-09-24T13:00:00Z"))).toBeNull();
  });
});

describe("nextAutoStatus — which orders it touches", () => {
  it("marketplace scope leaves the shop's own channels alone", () => {
    const late = AT("2026-09-24T12:30:00Z");
    for (const src of ["POS", "ONLINE", "VOICE", "WHATSAPP"]) {
      expect(nextAutoStatus(order({ orderSource: src, platform: null }), on(), late)).toBeNull();
    }
    for (const src of ["DELIVEROO", "UBER_EATS", "JUST_EAT", "HUBRISE"]) {
      expect(nextAutoStatus(order({ orderSource: src }), on(), late)).toBe("READY");
    }
  });

  it("ALL scope covers the shop's own channels too", () => {
    expect(
      nextAutoStatus(
        order({ orderSource: "POS", platform: null }),
        on({ scope: "ALL" }),
        AT("2026-09-24T12:30:00Z"),
      ),
    ).toBe("READY");
  });

  it("never closes off an OPEN TAB, which sits accepted for the whole meal", () => {
    expect(
      nextAutoStatus(
        order({
          fulfillmentType: "DINE_IN",
          orderSource: "POS",
          platform: null,
          isOpenTab: true,
        }),
        on({ scope: "ALL" }),
        AT("2026-09-24T14:00:00Z"),
      ),
    ).toBeNull();
  });

  // The bug this replaced: the exemption tested `fulfillmentType === "DINE_IN"`,
  // so every pay-at-the-table QR order was excluded too. Those are dine-in and
  // paid for and nothing is ever added to them, so a shop with Auto ready on
  // watched its table tickets sit in Accepted for the whole service.
  it("does advance a prepaid table round — dine-in, but not a tab", () => {
    expect(
      nextAutoStatus(
        order({
          fulfillmentType: "DINE_IN",
          orderSource: "POS",
          platform: null,
          isOpenTab: false,
        }),
        on({ scope: "ALL" }),
        AT("2026-09-24T14:00:00Z"),
      ),
    ).toBe("READY");
  });

  it("still needs ALL scope — a table order is not a marketplace order", () => {
    expect(
      nextAutoStatus(
        order({
          fulfillmentType: "DINE_IN",
          orderSource: "POS",
          platform: null,
          isOpenTab: false,
        }),
        on({ scope: "MARKETPLACE" }),
        AT("2026-09-24T14:00:00Z"),
      ),
    ).toBeNull();
  });
});

describe("nextAutoStatus — scheduled orders", () => {
  // Taken at noon for 7pm: ready at 7pm, not at ten past twelve.
  const forSeven = order({ scheduledFor: AT("2026-09-24T19:00:00Z") });

  it("ignores the accept time and counts back from when the customer wants it", () => {
    expect(nextAutoStatus(forSeven, on(), AT("2026-09-24T12:30:00Z"))).toBeNull();
    expect(nextAutoStatus(forSeven, on(), AT("2026-09-24T18:40:00Z"))).toBeNull();
    // ready 19:00, preparing 13 minutes earlier (15 − 2).
    expect(nextAutoStatus(forSeven, on(), AT("2026-09-24T18:47:00Z"))).toBe("PREPARING");
    expect(
      nextAutoStatus({ ...forSeven, status: "PREPARING" }, on(), AT("2026-09-24T19:00:00Z")),
    ).toBe("READY");
  });

  it("treats a scheduled time already in the past as an ordinary order", () => {
    const late = order({ scheduledFor: AT("2026-09-24T11:00:00Z") });
    expect(nextAutoStatus(late, on(), AT("2026-09-24T12:02:00Z"))).toBe("PREPARING");
  });
});

describe("nextAutoStatus — falls back sensibly", () => {
  it("times from creation when an order has no accepted time", () => {
    expect(
      nextAutoStatus(order({ acceptedAt: null }), on(), AT("2026-09-24T12:02:00Z")),
    ).toBe("PREPARING");
  });
});
