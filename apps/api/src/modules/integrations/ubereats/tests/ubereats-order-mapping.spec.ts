import {
  mapUberEatsOrder,
  mapUberFulfillment,
  moneyToPounds,
} from "../ubereats-order.mappers";

// Payload constructed 1:1 from the partner OpenAPI spec (Order Fulfillment
// API 1.0.0): money as amount_e5 (×10^5), per-line prices in
// payment.payment_detail.item_charges.price_breakdown keyed by cart_item_id,
// modifiers as selected_modifier_groups[].selected_items[].

const money = (pounds: number) => ({
  gross: { amount_e5: Math.round(pounds * 100_000), currency_code: "GBP" },
  net: { amount_e5: Math.round(pounds * 100_000 * 0.8) },
  tax: { amount_e5: Math.round(pounds * 100_000 * 0.2) },
});

const ORDER = {
  id: "uber-order-123",
  display_id: "A1B2C",
  state: "OFFERED",
  status: "ACTIVE",
  fulfillment_type: "DELIVERY_BY_UBER",
  store: { id: "store-uuid-9", name: "Pizza Uno" },
  customers: [
    {
      id: "cust-1",
      is_primary_customer: true,
      name: { display_name: "Jane D", first_name: "Jane", last_name: "D" },
      contact: {
        phone: { number: "+44-800-123-4567", pin_code: "888 52 337" },
      },
    },
  ],
  carts: [
    {
      id: "cart-1",
      special_instructions: "Ring the bell",
      items: [
        {
          id: "item-marg",
          cart_item_id: "ci-1",
          title: "Margherita - 12 inch",
          external_data: "PLU-1",
          quantity: { amount: 2 },
          customer_request: { special_instructions: "extra crispy" },
          selected_modifier_groups: [
            {
              id: "grp-top",
              title: "Toppings",
              selected_items: [
                {
                  id: "opt-chz",
                  cart_item_id: "ci-2",
                  title: "Extra cheese",
                  quantity: { amount: 1 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  payment: {
    payment_detail: {
      currency_code: "GBP",
      order_total: money(21.4),
      item_charges: {
        total: money(19.5),
        price_breakdown: [
          {
            cart_item_id: "ci-1",
            price_type: "ITEM",
            unit: money(8.5),
            total: money(17.0),
          },
          {
            cart_item_id: "ci-2",
            price_type: "OPTION",
            unit: money(1.25),
            total: money(2.5),
          },
        ],
      },
      promotions: { total: money(1.1) },
      cash_amount_due: money(0),
    },
  },
  preparation_time: {
    ready_for_pickup_time: "2026-07-04T12:00:00Z",
    source: "PREDICTED_BY_UBER",
  },
  store_instructions: "no cutlery",
};

describe("mapUberEatsOrder", () => {
  const c = mapUberEatsOrder(ORDER)!;

  it("maps identity + platform fields", () => {
    expect(c.externalId).toBe("uber-order-123");
    expect(c.platform).toBe("UBER_EATS");
    expect(c.orderSource).toBe("UBER_EATS");
    expect(c.integrationSource).toBe("DIRECT");
    expect(c.viaHubrise).toBe(false);
    expect(c.displayId).toBe("A1B2C");
  });

  it("maps the customer with the anonymised phone + pin", () => {
    expect(c.customerInfo.name).toBe("Jane D");
    expect(c.customerInfo.phone).toBe("+44-800-123-4567");
    expect((c.metadata as any).phonePin).toBe("888 52 337");
  });

  it("prices items from the payment breakdown, not the item objects", () => {
    expect(c.items).toHaveLength(1);
    const it = c.items[0];
    expect(it.name).toBe("Margherita - 12 inch");
    expect(it.quantity).toBe(2);
    expect(it.unitPrice).toBe(8.5);
    expect(it.totalPrice).toBe(17.0);
    expect(it.sku).toBe("PLU-1");
    expect(it.notes).toBe("extra crispy");
    expect(it.modifiers).toEqual([
      { name: "Extra cheese", price: 1.25, quantity: 1 },
    ]);
  });

  it("converts e5 money to pounds", () => {
    expect(c.total).toBe(21.4);
    expect(c.subtotal).toBe(19.5);
    expect(c.discount).toBe(1.1);
    expect(c.taxAmount).toBeCloseTo(21.4 * 0.2, 2);
  });

  it("maps DELIVERY_BY_UBER to a platform courier with PLATFORM gating", () => {
    expect(c.fulfillmentType).toBe("PLATFORM_COURIER");
    expect((c.metadata as any).deliveryType).toBe("PLATFORM");
  });

  it("carries cart + store instructions", () => {
    expect(c.specialInstructions).toBe("Ring the bell");
    expect((c.metadata as any).storeInstructions).toBe("no cutlery");
    expect((c.metadata as any).uberStoreId).toBe("store-uuid-9");
  });

  it("handles scheduled orders", () => {
    const s = mapUberEatsOrder({
      ...ORDER,
      status: "SCHEDULED",
      scheduled_order_target_delivery_time_range: {
        start_time: "2026-07-05T18:30:00Z",
        end_time: "2026-07-05T18:50:00Z",
      },
    })!;
    expect(s.scheduledFor?.toISOString()).toBe("2026-07-05T18:30:00.000Z");
    // ACTIVE orders never get scheduledFor even if a range is present
    expect(c.scheduledFor).toBeUndefined();
  });

  it("returns null without an order id", () => {
    expect(mapUberEatsOrder({})).toBeNull();
  });
});

describe("fulfillment + money helpers", () => {
  it("maps all fulfillment types", () => {
    expect(mapUberFulfillment("PICKUP")).toBe("PICKUP");
    expect(mapUberFulfillment("DINE_IN")).toBe("DINE_IN");
    expect(mapUberFulfillment("DELIVERY_BY_MERCHANT")).toBe(
      "MERCHANT_DELIVERY",
    );
    expect(mapUberFulfillment("DELIVERY_BY_UBER")).toBe("PLATFORM_COURIER");
    expect(mapUberFulfillment(undefined)).toBe("PLATFORM_COURIER");
  });

  it("prefers gross, falls back to net+tax, never negative", () => {
    expect(moneyToPounds({ gross: { amount_e5: 750000 } })).toBe(7.5);
    expect(
      moneyToPounds({ net: { amount_e5: 600000 }, tax: { amount_e5: 150000 } }),
    ).toBe(7.5);
    expect(moneyToPounds({ gross: { amount_e5: -100 } })).toBe(0);
    expect(moneyToPounds(undefined)).toBe(0);
  });
});
