import {
  resolveDeliveryFee,
  deliveryZoneScope,
  resolveZoneOutcome,
} from "../ordering.service";

// A postcode that doesn't match any of the brand's delivery zones used to
// leave the order's delivery fee at whatever the client sent — usually 0,
// since that's the client's own no-match fallback. Order #MJBYC (pizza uno
// pelton) shipped with £0 delivery this way. resolveDeliveryFee is the
// server-side fix: a delivery order can only end up free when a genuine
// FREE_DELIVERY campaign actually applied — anything else falls back to the
// brand's highest configured zone fee, never to nothing.

describe("resolveDeliveryFee", () => {
  it("charges the highest zone fee when nothing was matched", () => {
    const fee = resolveDeliveryFee({
      fulfillmentType: "DELIVERY",
      requestedFee: 0,
      freeDeliveryApplied: false,
      zoneFees: [2.5, 4.0, 3.0],
    });
    expect(fee).toBe(4.0);
  });

  it("leaves a genuine FREE_DELIVERY campaign at zero", () => {
    const fee = resolveDeliveryFee({
      fulfillmentType: "DELIVERY",
      requestedFee: 0,
      freeDeliveryApplied: true,
      zoneFees: [2.5, 4.0],
    });
    expect(fee).toBe(0);
  });

  it("keeps a real matched-zone fee untouched", () => {
    const fee = resolveDeliveryFee({
      fulfillmentType: "DELIVERY",
      requestedFee: 3.5,
      freeDeliveryApplied: false,
      zoneFees: [2.5, 4.0],
    });
    expect(fee).toBe(3.5);
  });

  it("can't be forced free by a tampered cart when zones are configured", () => {
    // Client sends 0 (or omits deliveryFee entirely) while zones exist —
    // this is the exact shape of the bug being fixed.
    const fee = resolveDeliveryFee({
      fulfillmentType: "DELIVERY",
      requestedFee: undefined,
      freeDeliveryApplied: false,
      zoneFees: [5.0],
    });
    expect(fee).toBe(5.0);
  });

  it("stays at 0 when the brand has no zones configured at all", () => {
    // Nothing to fall back to — inventing a fee from no data would be
    // worse than the leak it's meant to fix.
    const fee = resolveDeliveryFee({
      fulfillmentType: "DELIVERY",
      requestedFee: 0,
      freeDeliveryApplied: false,
      zoneFees: [],
    });
    expect(fee).toBe(0);
  });

  it("never touches pickup or dine-in orders", () => {
    expect(
      resolveDeliveryFee({
        fulfillmentType: "PICKUP",
        requestedFee: 0,
        freeDeliveryApplied: false,
        zoneFees: [5.0],
      }),
    ).toBe(0);
    expect(
      resolveDeliveryFee({
        fulfillmentType: "DINE_IN",
        requestedFee: 0,
        freeDeliveryApplied: false,
        zoneFees: [5.0],
      }),
    ).toBe(0);
  });
});

// The earlier fix tested the max-of-fees maths but not WHICH fees got
// collected — and that's where order #JWDBH (pizza uno pelton) went wrong.
// It shipped with £0 delivery months after resolveDeliveryFee landed: the
// checkout carried no pinned brand, so the brand fell back to the location's
// default brand, that brand had no zones of its own, and a brand-only lookup
// found nothing to charge. These pin the SCOPE.
describe("deliveryZoneScope", () => {
  it("includes zones scoped directly to the location", () => {
    const where = deliveryZoneScope({ locationId: "loc-1", brandId: "brand-1" });
    expect(where.OR).toContainEqual({ locationId: "loc-1" });
  });

  it("includes zones scoped to the resolved brand", () => {
    const where = deliveryZoneScope({ locationId: "loc-1", brandId: "brand-1" });
    expect(where.OR).toContainEqual({ brandId: "brand-1" });
  });

  // The one that actually fixes #JWDBH: the order resolved to the location's
  // default brand, which had no zones, while the brand the customer really
  // ordered from did.
  it("includes zones from ANY brand serving that location", () => {
    const where = deliveryZoneScope({ locationId: "loc-1", brandId: "brand-1" });
    expect(where.OR).toContainEqual({
      brand: { locations: { some: { id: "loc-1" } } },
    });
  });

  it("still scopes by location when no brand could be resolved at all", () => {
    const where = deliveryZoneScope({ locationId: "loc-1", brandId: null });
    expect(where.OR).toContainEqual({ locationId: "loc-1" });
    expect(where.OR.some((c: any) => "brandId" in c)).toBe(false);
  });

  it("only ever considers active zones", () => {
    expect(deliveryZoneScope({ locationId: "loc-1" }).isActive).toBe(true);
  });
});

// Area mode inverts the rule above, and deliberately.
//
// "Charge the highest configured fee" exists because an unrecognised POSTCODE
// is a config gap — the shop probably does deliver there and losing the fee is
// worse than the customer paying the top rate. An unrecognised AREA is not a
// gap: the customer picked from a dropdown built out of the operator's own
// zone rows, so an area that isn't on it means the shop said it doesn't go
// there. Charging the top rate would be taking money for a delivery already
// ruled out.
describe("resolveZoneOutcome", () => {
  const areas = [
    { id: "marina", areaName: "Dubai Marina", fee: 15 },
    { id: "jlt", areaName: "JLT", fee: 12 },
  ];

  it("prices a matched area authoritatively", () => {
    expect(resolveZoneOutcome(areas, { area: "JLT" })).toEqual({
      kind: "CHARGE",
      fee: 12,
    });
  });

  it("refuses an area the shop does not serve", () => {
    expect(resolveZoneOutcome(areas, { area: "Al Quoz" })).toEqual({
      kind: "REFUSE",
      area: "Al Quoz",
    });
  });

  it("refuses a delivery order that never picked an area", () => {
    // Not a silent zero: the storefront disables Place order without one, so
    // reaching here means a client that bypassed the form.
    expect(resolveZoneOutcome(areas, {})).toEqual({
      kind: "REFUSE",
      area: undefined,
    });
  });

  it("ignores a postcode carried by a stale or tampered cart", () => {
    expect(
      resolveZoneOutcome(areas, { postcode: "SW1A 1AA", area: "Dubai Marina" }),
    ).toEqual({ kind: "CHARGE", fee: 15 });
  });

  it("leaves postcode shops on the highest-fee fallback", () => {
    expect(
      resolveZoneOutcome([{ id: "p", postcodePrefix: "SW1", fee: 3 }], {
        postcode: "E14 5AA",
      }),
    ).toEqual({ kind: "FALLBACK" });
    expect(resolveZoneOutcome([], {})).toEqual({ kind: "FALLBACK" });
  });
});

// Radius is authoritative too, and it did not used to be. The browser cannot
// measure distance, so the fee it sends is a guess — accepting it meant every
// radius shop charged its top band to everyone, including the customer across
// the road. The server measures and prices the real band.
describe("resolveZoneOutcome — distance bands", () => {
  const bands = [
    { id: "near", maxDistanceMiles: 2, fee: 2 },
    { id: "far", maxDistanceMiles: 5, fee: 6 },
  ];

  it("charges the band the customer actually falls in", () => {
    expect(resolveZoneOutcome(bands, { distanceMiles: 1.2 })).toEqual({
      kind: "CHARGE",
      fee: 2,
    });
  });

  it("charges the top band when the address could not be located", () => {
    // Failing expensive is the safe direction — a failed geocode read as
    // "0 miles" would hand every unresolvable address the cheapest band.
    expect(resolveZoneOutcome(bands, { distanceMiles: null })).toEqual({
      kind: "CHARGE",
      fee: 6,
    });
  });

  it("charges the top band past the furthest edge rather than refusing", () => {
    expect(resolveZoneOutcome(bands, { distanceMiles: 40 })).toEqual({
      kind: "CHARGE",
      fee: 6,
    });
  });
});
