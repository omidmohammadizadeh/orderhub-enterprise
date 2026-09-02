import { HubRiseAdapter } from "../adapters/hubrise.adapter";

// The delivery note on a Just Eat order relayed by HubRise.
//
// Order #939134370 (Grill Stop, 2 Sep) carried "Press the new style black
// door bell to left of door, please be patient we are at the rear of the
// house". HubRise showed it, Just Eat's own ticket printed it, and ours had
// nothing — the driver got the address and no way in.
//
// The adapter only read `customer_notes`, which is the ORDER note. HubRise
// carries the delivery instruction on the customer/delivery record, and the
// key it lands in varies by marketplace, so every candidate is checked.

const adapter = new HubRiseAdapter();

function hubriseOrder(over: Record<string, any> = {}) {
  return {
    id: "q6epnqb",
    ref: "939134370",
    status: "received",
    service_type: "delivery",
    channel: "Just Eat",
    connection_name: "GRILL STOP",
    created_at: "2026-09-02T20:31:00+01:00",
    customer: {
      first_name: "Rob",
      phone: "+447533006408",
      address_1: "20 Prince Alfred Street",
      city: "Gosport",
      postal_code: "PO12 1QH",
    },
    items: [
      {
        sku_ref: "waffle-fries",
        product_name: "Waffle Fries",
        quantity: "1.0",
        price: "4.99 GBP",
        subtotal: "4.99 GBP",
      },
    ],
    total: "4.99 GBP",
    ...over,
  };
}

const parse = (order: any) => adapter.normalize(order, "loc-001") as any;
const NOTE =
  "Press the new style black door bell to left of door, please be patient we are at the rear of the house.";

describe("HubRise delivery note", () => {
  it("reads delivery_notes off the customer — order #939134370", () => {
    const c = parse(
      hubriseOrder({
        customer: { ...hubriseOrder().customer, delivery_notes: NOTE },
      }),
    );
    expect(c.specialInstructions).toBe(NOTE);
  });

  it("reads it off the delivery object when HubRise sends one", () => {
    const c = parse(
      hubriseOrder({
        delivery: {
          address_1: "20 Prince Alfred Street",
          postal_code: "PO12 1QH",
          delivery_notes: NOTE,
        },
      }),
    );
    expect(c.specialInstructions).toBe(NOTE);
  });

  it("keeps the order note as well when a shop has both", () => {
    const c = parse(
      hubriseOrder({
        customer_notes: "No cutlery",
        customer: { ...hubriseOrder().customer, delivery_notes: NOTE },
      }),
    );
    expect(c.specialInstructions).toBe(`No cutlery — ${NOTE}`);
  });

  it("does not print the same text twice when both fields carry it", () => {
    const c = parse(
      hubriseOrder({
        customer_notes: NOTE,
        customer: { ...hubriseOrder().customer, delivery_notes: NOTE },
      }),
    );
    expect(c.specialInstructions).toBe(NOTE);
  });

  it("leaves it unset when there is no note at all", () => {
    expect(parse(hubriseOrder()).specialInstructions).toBeUndefined();
  });
});
