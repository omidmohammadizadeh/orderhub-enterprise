import { HubRiseAdapter } from "../adapters/hubrise.adapter";

// A service charge arriving through HubRise.
//
// Same class of bug as the delivery fee before it. Order 4jjdb97 (Just Eat via
// HubRise, 15 Sep 2026) carried charges of £3.00 delivery and £1.49 service
// against a £46.71 subtotal and a £51.20 total. The adapter recognised both —
// it logged `unexplained=0` — but only ever emitted deliveryFee, so the ticket
// printed 46.71 + 3.00 against a 51.20 total and £1.49 went unnamed.
//
// The totals were never wrong: `total` comes from HubRise. What was wrong is
// that nothing on the receipt accounted for the difference.

const adapter = new HubRiseAdapter();

function hubriseOrder(over: Record<string, any> = {}) {
  return {
    id: "4jjdb97",
    ref: "948419609",
    status: "new",
    service_type: "delivery",
    channel: "Just Eat",
    connection_name: "DE SALT",
    created_at: "2026-09-15T18:47:08+01:00",
    customer: { first_name: "McCartney", last_name: "" },
    items: [
      {
        sku_ref: "kebab",
        product_name: "Mixed Kebab",
        quantity: "1.0",
        price: "46.71 GBP",
        subtotal: "46.71 GBP",
      },
    ],
    charges: [
      { name: "Delivery charge", type: "delivery", price: "3.00 GBP" },
      { name: "Service charge", type: "other", price: "1.49 GBP" },
    ],
    total: "51.20 GBP",
    ...over,
  };
}

const parse = (order: any) => adapter.normalize(order, "loc-001") as any;

describe("HubRise service charge", () => {
  it("reads a charge line that names itself a service charge", () => {
    expect(parse(hubriseOrder()).serviceCharge).toBe(1.49);
  });

  it("keeps the delivery charge separate from it", () => {
    const out = parse(hubriseOrder());
    expect(out.deliveryFee).toBe(3);
    expect(out.serviceCharge).toBe(1.49);
  });

  it("adds up, so the ticket explains its own total", () => {
    const out = parse(hubriseOrder());
    const parts =
      out.subtotal + out.deliveryFee + out.serviceCharge - out.discount;
    expect(Number(parts.toFixed(2))).toBe(out.total);
  });

  it("is 0 when the marketplace charges none", () => {
    const out = parse(
      hubriseOrder({
        charges: [{ name: "Delivery charge", type: "delivery", price: "3.00 GBP" }],
        total: "49.71 GBP",
      }),
    );
    expect(out.serviceCharge).toBe(0);
  });

  it("does not mistake a tip for a service charge", () => {
    // Tips have no column on Order yet; misfiling one as a service charge
    // would put the driver's money on the shop's receipt as a shop charge.
    const out = parse(
      hubriseOrder({
        charges: [
          { name: "Delivery charge", type: "delivery", price: "3.00 GBP" },
          { name: "Tip", type: "tip", price: "2.00 GBP" },
        ],
        total: "51.71 GBP",
      }),
    );
    expect(out.serviceCharge).toBe(0);
  });
});
