import { resolveDeliveryFee, deliveryZoneScope } from "../ordering.service";

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
