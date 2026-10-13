import {
  NormalisedQuote,
  OrderLike,
  RuleLike,
  dueAt,
  ineligibleReason,
  pickRule,
  rankProviders,
  toMinor,
} from "../auto-dispatch.logic";

const T0 = new Date("2026-10-13T12:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function rule(over: Partial<RuleLike> = {}): RuleLike {
  return {
    id: "r1",
    enabled: true,
    priority: 100,
    locationId: null,
    brandIds: [],
    channels: [],
    strategy: "FIXED",
    providers: ["JET_GO"],
    fallback: true,
    trigger: "ON_ACCEPT",
    delayMinutes: 0,
    maxPriceMinor: null,
    dryRun: false,
    enabledAt: min(-60),
    createdAt: min(-60),
    ...over,
  };
}

function order(over: Partial<OrderLike> = {}): OrderLike {
  return {
    id: "o1",
    locationId: "loc1",
    brandId: "b1",
    orderSource: "DIRECT",
    status: "ACCEPTED",
    fulfillmentType: "DELIVERY",
    deliveryType: null,
    courierJobId: null,
    acceptedAt: T0,
    readyAt: null,
    estimatedReadyAt: null,
    preparationMinutes: null,
    scheduledFor: null,
    createdAt: min(-2),
    ...over,
  };
}

const q = (provider: any, amountMinor: number | null, extra: Partial<NormalisedQuote> = {}): NormalisedQuote => ({
  provider,
  ok: amountMinor != null,
  amountMinor,
  currency: "GBP",
  canDispatch: true,
  ...extra,
});

describe("auto dispatch — which orders", () => {
  it("never touches a marketplace rider's order or one already on a courier", () => {
    expect(ineligibleReason(order({ fulfillmentType: "PLATFORM_COURIER" }))).toBeTruthy();
    expect(ineligibleReason(order({ fulfillmentType: "PICKUP" }))).toBeTruthy();
    expect(ineligibleReason(order({ courierJobId: "job" }))).toBeTruthy();
    expect(ineligibleReason(order({ deliveryType: "PLATFORM" }))).toBeTruthy();
    expect(ineligibleReason(order({ status: "PENDING" }))).toBeTruthy();
    expect(ineligibleReason(order({ fulfillmentType: "MERCHANT_DELIVERY" }))).toBeNull();
  });

  it("matches on location, brand and channel; empty lists mean any", () => {
    const r = rule({ locationId: "loc1", brandIds: ["b1"], channels: ["JUST_EAT"] });
    expect(pickRule([r], order({ orderSource: "JUST_EAT" }))).toBe(r);
    expect(pickRule([r], order({ orderSource: "DIRECT" }))).toBeNull();
    expect(pickRule([r], order({ orderSource: "JUST_EAT", brandId: "b2" }))).toBeNull();
    expect(pickRule([r], order({ orderSource: "JUST_EAT", locationId: "loc2" }))).toBeNull();
    expect(pickRule([r], order({ orderSource: "JUST_EAT", brandId: null }))).toBeNull();
  });

  it("leaves orders taken before the rule was switched on", () => {
    const r = rule({ enabledAt: min(5) });
    expect(pickRule([r], order())).toBeNull();
  });

  it("lowest priority number wins", () => {
    const a = rule({ id: "a", priority: 50 });
    const b = rule({ id: "b", priority: 10 });
    expect(pickRule([a, b], order())?.id).toBe("b");
  });
});

describe("auto dispatch — when", () => {
  it("ON_ACCEPT fires after the delay", () => {
    expect(dueAt(rule({ delayMinutes: 5 }), order())).toEqual(min(5));
  });

  it("ON_READY waits until the order is ready", () => {
    const r = rule({ trigger: "ON_READY", delayMinutes: 2 });
    expect(dueAt(r, order())).toBeNull();
    expect(dueAt(r, order({ status: "READY", readyAt: min(15) }))).toEqual(min(17));
  });

  it("BEFORE_READY books N minutes before the food is due", () => {
    const r = rule({ trigger: "BEFORE_READY", delayMinutes: 10 });
    expect(dueAt(r, order({ estimatedReadyAt: min(25) }))).toEqual(min(15));
    // No estimate: accepted + prep (order → location → 20).
    expect(dueAt(r, order({ preparationMinutes: 30 }))).toEqual(min(20));
    expect(dueAt(r, order(), 15)).toEqual(min(5));
    expect(dueAt(r, order())).toEqual(min(10));
  });

  it("a scheduled order is never booked before its cooking window", () => {
    const r = rule({ trigger: "ON_ACCEPT" });
    const o = order({ scheduledFor: min(7 * 60), preparationMinutes: 20 });
    expect(dueAt(r, o)).toEqual(min(7 * 60 - 20));
  });
});

describe("auto dispatch — to whom", () => {
  it("CHEAPEST ranks bookable quotes by price", () => {
    const r = rule({ strategy: "CHEAPEST", providers: ["STUART", "UBER_DIRECT", "JET_GO"] });
    const quotes = [q("STUART", 650), q("UBER_DIRECT", 520), q("JET_GO", 600)];
    expect(rankProviders(r, quotes)).toEqual(["UBER_DIRECT", "JET_GO", "STUART"]);
  });

  it("CHEAPEST skips failed, unbookable and over-cap quotes", () => {
    const r = rule({ strategy: "CHEAPEST", maxPriceMinor: 600, providers: ["STUART", "UBER_DIRECT", "JET_GO", "YANGO"] });
    const quotes = [
      q("STUART", null, { error: "out of range" }),
      q("UBER_DIRECT", 700),
      q("JET_GO", 600),
      q("YANGO", 100, { canDispatch: false }),
    ];
    expect(rankProviders(r, quotes)).toEqual(["JET_GO"]);
  });

  it("without fallback only the first choice is tried", () => {
    const r = rule({ strategy: "CHEAPEST", fallback: false, providers: ["STUART", "JET_GO"] });
    expect(rankProviders(r, [q("STUART", 500), q("JET_GO", 400)])).toEqual(["JET_GO"]);
  });

  it("FIXED keeps the rule's order and needs no quote", () => {
    const r = rule({ providers: ["JET_GO", "STUART"] });
    expect(rankProviders(r, [])).toEqual(["JET_GO", "STUART"]);
  });

  it("FIXED with a cap drops a provider priced over it", () => {
    const r = rule({ providers: ["JET_GO", "STUART"], maxPriceMinor: 500 });
    expect(rankProviders(r, [q("JET_GO", 650), q("STUART", 480)])).toEqual(["STUART"]);
  });

  it("a missing price is never a free delivery", () => {
    expect(toMinor(null)).toBeNull();
    expect(toMinor("")).toBeNull();
    expect(toMinor("abc")).toBeNull();
    expect(toMinor(6)).toBe(600);
    expect(toMinor("4.25")).toBe(425);
    expect(toMinor(0)).toBe(0);
  });
});
