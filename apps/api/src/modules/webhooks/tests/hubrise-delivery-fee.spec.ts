import { HubRiseAdapter } from "../adapters/hubrise.adapter";

// A marketplace delivery charge arriving through HubRise.
//
// deliveryFee was hard-coded to 0, so the charge vanished on the way in:
// order #06069 showed items totalling £16.80 against a £19.80 total with
// nothing accounting for the £3, on the card and on the printed ticket.
//
// HubRise puts fees in a `charges` array. Where a charge names itself we use
// it; where nothing does, a DELIVERY order whose total exceeds its items has
// a delivery charge in it, and inferring beats printing a ticket that does
// not add up. Collection orders infer nothing — there the gap is a service
// charge or a tip.

const adapter = new HubRiseAdapter();

/** Shaped like the real webhook: money as "<amount> <currency>" strings. */
function hubriseOrder(over: Record<string, any> = {}) {
  return {
    id: "n9x26rk",
    ref: "06069",
    status: "received",
    service_type: "delivery",
    channel: "Uber Eats",
    connection_name: "KINGSTON PIZZA",
    created_at: "2026-08-04T17:49:00+01:00",
    customer: { first_name: "Will", last_name: "T." },
    items: [
      {
        sku_ref: "calzone",
        product_name: "12inch Make Your Own Calzone With 4 Toppings",
        quantity: "1.0",
        price: "16.80 GBP",
        subtotal: "16.80 GBP",
      },
    ],
    total: "19.80 GBP",
    ...over,
  };
}

const parse = (order: any) => adapter.normalize(order, "loc-001") as any;

describe("HubRise delivery fee", () => {
  it("reads a charge line that names itself delivery", () => {
    const c = parse(
      hubriseOrder({
        charges: [{ name: "Delivery", type: "delivery", price: "3.00 GBP" }],
      }),
    );
    expect(c.deliveryFee).toBe(3);
  });

  it("matches on the charge name when the type is generic", () => {
    const c = parse(
      hubriseOrder({
        charges: [{ name: "Delivery fee", type: "other", price: "3.00 GBP" }],
      }),
    );
    expect(c.deliveryFee).toBe(3);
  });

  it("infers the fee on a delivery order with no charge lines at all", () => {
    // Order #06069 exactly: £16.80 of items, £19.80 total, no charges array.
    const c = parse(hubriseOrder());
    expect(c.subtotal).toBe(16.8);
    expect(c.total).toBe(19.8);
    expect(c.deliveryFee).toBe(3);
  });

  it("never infers a delivery fee on a collection order", () => {
    const c = parse(hubriseOrder({ service_type: "collection" }));
    expect(c.deliveryFee).toBe(0);
  });

  it("does not double-count a named delivery charge as unexplained", () => {
    const c = parse(
      hubriseOrder({
        charges: [{ name: "Delivery", type: "delivery", price: "3.00 GBP" }],
      }),
    );
    expect(c.deliveryFee).toBe(3);
    expect(c.metadata.hubriseUnexplainedTotal).toBe(0);
  });

  it("leaves a service charge out of the delivery fee", () => {
    const c = parse(
      hubriseOrder({
        total: "21.30 GBP",
        charges: [
          { name: "Delivery", type: "delivery", price: "3.00 GBP" },
          { name: "Service charge", type: "service", price: "1.50 GBP" },
        ],
      }),
    );
    expect(c.deliveryFee).toBe(3);
    expect(c.metadata.hubriseUnexplainedTotal).toBe(0);
  });

  it("accounts for a discount before deciding what is unexplained", () => {
    // £16.80 items − £2 off + £3 delivery = £17.80.
    const c = parse(
      hubriseOrder({
        total: "17.80 GBP",
        discounts: [{ name: "2 off", price_off: "-2.00 GBP" }],
      }),
    );
    expect(c.discount).toBe(2);
    expect(c.deliveryFee).toBe(3);
  });

  it("infers nothing when the total already matches the items", () => {
    const c = parse(hubriseOrder({ total: "16.80 GBP" }));
    expect(c.deliveryFee).toBe(0);
  });

  it("keeps the raw charge lines for proof", () => {
    const charges = [{ name: "Delivery", type: "delivery", price: "3.00 GBP" }];
    expect(parse(hubriseOrder({ charges })).metadata.hubriseCharges).toEqual(
      charges,
    );
  });
});
