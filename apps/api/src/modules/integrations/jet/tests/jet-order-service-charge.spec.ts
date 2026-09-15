import { transformJetOrder } from "../jet-order.transformer";

// Built from the FIRST REAL order Just Eat ever sent us — order
// qjg0n0qhyeu7wmn7hy4sig / ref 948345461, 15 Sep 2026 — not from the spec.
//
// It arrived with a 75p service charge in payment.adjustments. The total was
// right (£8.55) but the printed ticket read "subtotal 7.80 … total 8.55" with
// nothing accounting for the difference, because the transformer put
// serviceCharge in metadata only, while ingestCanonical writes the column from
// the TOP-LEVEL field the way it does deliveryFee and discount.
const REAL_ORDER = {
  channel: { id: 32, name: "Just Eat" },
  created_at: "1789490476",
  deliver_at: "1789493400",
  delivery: {
    city: "London",
    first_name: "OMID",
    last_name: "MOHAMMADIZADEH",
    line_one: "big ben, 10",
    line_two: "London",
    phone_number: "07533 006 408",
    postcode: "SW1A 0AA",
  },
  extras: { asap: "true", justEatOrderReference: "qjg0n0qhyeu7wmn7hy4sig" },
  id: "qjg0n0qhyeu7wmn7hy4sig",
  items: [
    {
      children: [
        { children: [], name: "Mussels", plu: "MOD-T2F5UE", price: 100 },
        { children: [], name: "Garlic Base", plu: "MOD-CA8ZA3", price: 0 },
      ],
      name: 'Al Funghi Pizza 10"',
      plu: "cmu1b70wu006jg9qle98846vk__s0",
      price: 680,
    },
  ],
  location: { id: 440823, timezone: "Europe/London" },
  payment: {
    adjustments: [{ name: "serviceCharge", price: { inc_tax: 75, tax: 0 } }],
    deposit: 0,
    final: { inc_tax: 855, tax: 0 },
    items_in_cart: { inc_tax: 780, tax: 0 },
  },
  payment_method: "CASH",
  posLocationId: "440823",
  promotions: [],
  third_party_order_reference: "948345461",
  total: 780,
  type: "delivery-by-merchant",
};

describe("JET order transform — the service charge reaches the receipt", () => {
  it("puts the service charge where ingestCanonical reads it", () => {
    const { canonical } = transformJetOrder(REAL_ORDER as any);
    expect((canonical as any).serviceCharge).toBe(0.75);
  });

  it("still keeps the totals JET sent, rather than re-deriving them", () => {
    const { canonical } = transformJetOrder(REAL_ORDER as any);
    expect(canonical.subtotal).toBe(7.8);
    expect(canonical.total).toBe(8.55);
  });

  it("adds up: subtotal + service charge = the total on the ticket", () => {
    const { canonical } = transformJetOrder(REAL_ORDER as any);
    const parts =
      canonical.subtotal +
      (canonical as any).serviceCharge +
      canonical.deliveryFee -
      canonical.discount;
    expect(Number(parts.toFixed(2))).toBe(canonical.total);
  });
});
