import { normalizePick, parseSubstitutionPref, priceShortfall } from "../retail.logic";

describe("picking maths", () => {
  const milk = { id: "m", name: "Milk", quantity: 2, totalMinor: 310 }; // £1.55 each
  const base = { subtotalMinor: 310, discountMinor: 0 };

  it("refunds nothing when everything was picked", () => {
    expect(priceShortfall({ ...base, lines: [{ ...milk, pick: { picked: 2 } }] }).refundMinor).toBe(0);
  });

  it("refunds a missing unit at what the customer paid", () => {
    const r = priceShortfall({ ...base, lines: [{ ...milk, pick: { picked: 1 } }] });
    expect(r.refundMinor).toBe(155);
    expect(r.lines[0]).toMatchObject({ missing: 1, substituted: 0 });
  });

  it("treats a line nobody touched as all missing", () => {
    expect(priceShortfall({ ...base, lines: [{ ...milk, pick: null }] }).lines[0]!.missing).toBe(2);
  });

  it("never charges more for a dearer substitute", () => {
    const r = priceShortfall({
      ...base,
      lines: [{ ...milk, pick: { picked: 1, sub: { name: "Organic milk", qty: 1, unitPrice: 2.2 } } }],
    });
    expect(r.refundMinor).toBe(0);
    expect(r.lines[0]).toMatchObject({ missing: 0, substituted: 1 });
  });

  it("refunds the difference for a cheaper substitute", () => {
    const r = priceShortfall({
      ...base,
      lines: [{ ...milk, pick: { picked: 0, sub: { name: "Own-brand milk", qty: 2, unitPrice: 1.05 } } }],
    });
    expect(r.refundMinor).toBe(100); // 2 × 50p
  });

  it("scales by an order discount, like a till return", () => {
    const r = priceShortfall({
      subtotalMinor: 1000,
      discountMinor: 200,
      lines: [{ id: "x", name: "Soap", quantity: 10, totalMinor: 1000, pick: { picked: 9 } }],
    });
    expect(r.refundMinor).toBe(80);
  });

  it("validates a pick against the ordered quantity", () => {
    expect(() => normalizePick({ name: "Milk", quantity: 2 }, { picked: 3 })).toThrow("between 0 and 2");
    expect(() =>
      normalizePick({ name: "Milk", quantity: 2 }, { picked: 1, sub: { name: "X", qty: 2, unitPrice: 1 } }),
    ).toThrow("Only 1 × Milk can be substituted");
    expect(() =>
      normalizePick({ name: "Milk", quantity: 2 }, { picked: 1, sub: { name: " ", qty: 1, unitPrice: 1 } }),
    ).toThrow("Name the substitute");
    expect(normalizePick({ name: "Milk", quantity: 2 }, { picked: 1, sub: { name: "Oat", qty: 1, unitPrice: 1.999 } }))
      .toEqual({ picked: 1, sub: { variantId: null, menuItemId: null, name: "Oat", qty: 1, unitPrice: 2 } });
  });

  it("accepts only known substitution choices", () => {
    expect(parseSubstitutionPref("NONE")).toBe("NONE");
    expect(parseSubstitutionPref("ANYTHING")).toBeUndefined();
  });
});
