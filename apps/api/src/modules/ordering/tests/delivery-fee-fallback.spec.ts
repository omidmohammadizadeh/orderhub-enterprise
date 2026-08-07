import { resolveDeliveryFee } from "../ordering.service";

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
