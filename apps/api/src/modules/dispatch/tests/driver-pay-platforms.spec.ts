import { HubRiseAdapter } from "../../webhooks/adapters/hubrise.adapter";
import { JustEatAdapter } from "../../webhooks/adapters/just-eat.adapter";
import { UberEatsAdapter } from "../../webhooks/adapters/uber-eats.adapter";
import { DeliverooAdapter } from "../../webhooks/adapters/deliveroo.adapter";
import { mapUberEatsOrder } from "../../integrations/ubereats/ubereats-order.mappers";
import { transformJetOrder } from "../../integrations/jet/jet-order.transformer";
import { DELIVERY_BY_MERCHANT } from "../../integrations/jet/tests/jet-order.fixtures";
import { transformGlovoOrder } from "../../integrations/glovo/glovo-order.transformer";
import { GLOVO_MARKETPLACE_ORDER } from "../../integrations/glovo/tests/glovo-order.fixtures";
import { transformTalabatOrder } from "../../integrations/talabat/talabat-order.transformer";
import { ITEM_LEVEL_DISCOUNT_EXAMPLE } from "../../integrations/talabat/tests/talabat-spec-examples";
import { summariseStops } from "../driver-earnings.service";

// Driver postcode fees, platform by platform.
//
// Every platform's order is stored the way its converter leaves it: the address
// in the deliveryAddress blob, the postcode column empty. Pay read the column
// and paid £0 in fees on all of them (Kingston Pizza, Nov 2026). Each case
// below runs the platform's REAL converter on an order shaped like the ones it
// sends, stores the result that way, and checks the driver is paid the fee.

const FEE = 4;

function feeFor(deliveryAddress: unknown, rulePostcode: string): number {
  const driver = { startupFee: "0", postcodeFees: [{ postcode: rulePostcode, fee: FEE }] };
  return summariseStops(driver, [
    {
      status: "DELIVERED" as any,
      deliveredAt: new Date("2026-11-02T18:00:00Z"),
      order: { total: 20, paymentMethod: "CARD", postcode: null, deliveryAddress },
    },
  ]).deliveryFeeTotal;
}

const hubriseOrder = (channel: string, delivery: Record<string, unknown>) => ({
  id: "n9x26rk",
  ref: "06069",
  status: "received",
  service_type: "delivery",
  channel,
  connection_name: "KINGSTON PIZZA",
  created_at: "2026-11-02T17:49:00+00:00",
  customer: { first_name: "Will", last_name: "T." },
  delivery,
  items: [{ sku_ref: "calzone", product_name: "Calzone", quantity: "1.0", price: "16.80 GBP", subtotal: "16.80 GBP" }],
  total: "16.80 GBP",
});

describe("driver postcode fee is paid on every platform's orders", () => {
  it.each(["Uber Eats", "Deliveroo", "Just Eat", "Online ordering"])("HubRise — %s", (channel) => {
    const canonical = new HubRiseAdapter().normalize(
      hubriseOrder(channel, { address_1: "3 Darwin Crescent", city: "Newcastle", postal_code: "ne3 4tt" }),
      "loc-1",
    );
    expect(feeFor(canonical?.deliveryAddress, "NE3")).toBe(FEE);
  });

  it("Just Eat (direct, JET Connect)", () => {
    const canonical = transformJetOrder(DELIVERY_BY_MERCHANT)?.canonical;
    expect(canonical?.deliveryAddress).toBeDefined();
    expect(feeFor(canonical?.deliveryAddress, "R3B")).toBe(FEE);
  });

  it("Deliveroo (direct) — postcode sent without a space", () => {
    const canonical = new DeliverooAdapter().normalize(
      {
        order: {
          id: "gb:order-1",
          display_id: "9962",
          status: "placed",
          fulfillment_type: "restaurant",
          location_id: "452692",
          items: [{ name: "Burger", quantity: 1, unit_price: { fractional: 550, currency_code: "GBP" }, total_price: { fractional: 550, currency_code: "GBP" } }],
          total_price: { fractional: 550, currency_code: "GBP" },
          delivery: { line1: "15 Front Street", city: "Newcastle", postcode: "DH21LY" },
        },
      },
      "loc-1",
    );
    expect(feeFor(canonical?.deliveryAddress, "DH2")).toBe(FEE);
  });

  it("Uber Eats (direct API)", () => {
    const canonical = mapUberEatsOrder({
      id: "o1",
      store: { id: "s1" },
      fulfillment_type: "DELIVERY_BY_RESTAURANT",
      deliveries: [{ location: { street_address_line_one: "12 Kenton Road", city: "Newcastle", postal_code: "NE3 1AA" } }],
      carts: [],
    } as never);
    expect(feeFor(canonical?.deliveryAddress, "NE3")).toBe(FEE);
  });

  it("Uber Eats (webhook)", () => {
    const canonical = new UberEatsAdapter().normalize(
      {
        event_type: "orders.notification",
        meta: { resource_id: "ue-1" },
        order: {
          id: "ue-1",
          display_id: "AB12",
          cart: { items: [{ title: "Burger", quantity: 1, price: { unit_price: { amount: 1000 } } }] },
          delivery_information: { type: "DELIVERY", location: { address: "1 Main St", city: "London", zip_code: "SW1A 1AA" } },
          payment: { charges: { subtotal: { amount: 1000 }, total: { amount: 1000 } } },
        },
      },
      "loc-1",
    );
    expect(feeFor(canonical?.deliveryAddress, "SW1A")).toBe(FEE);
  });

  it("Just Eat (webhook)", () => {
    const canonical = new JustEatAdapter().normalize(
      {
        event: "order_placed",
        order: {
          order_id: "je-1",
          service_type: "delivery",
          total_price: 20,
          order_lines: [{ name: "Kebab", quantity: 1, unit_price: 20 }],
          customer: { first_name: "Sam" },
          delivery: { address: { address1: "4 Grey Street", city: "Newcastle", postcode: "NE1 6EE" } },
        },
      },
      "loc-1",
    );
    expect(canonical?.deliveryAddress).toBeDefined();
    expect(feeFor(canonical?.deliveryAddress, "NE1")).toBe(FEE);
  });

  it("Glovo", () => {
    const canonical = transformGlovoOrder(GLOVO_MARKETPLACE_ORDER as any, { country: "ES" })?.canonical;
    expect(feeFor(canonical?.deliveryAddress, "08001")).toBe(FEE);
  });

  const talabatWith = (address: Record<string, unknown>) => {
    const order = JSON.parse(JSON.stringify(ITEM_LEVEL_DISCOUNT_EXAMPLE));
    Object.assign(order.delivery.address, address);
    return transformTalabatOrder(order, { remoteId: "OH-1" }).canonical;
  };

  it("Talabat (shop's own driver)", () => {
    expect(feeFor(talabatWith({ postcode: "10117" }).deliveryAddress, "10117")).toBe(FEE);
  });

  // Talabat often leaves the street postcode blank and gives the area's.
  it("Talabat — postcode only on the delivery area", () => {
    expect(feeFor(talabatWith({ postcode: "", deliveryAreaPostcode: "10117" }).deliveryAddress, "10117")).toBe(FEE);
  });

  it("website and app orders (storefront checkout)", () => {
    expect(feeFor({ line1: "35 Brunel Street", city: "Newcastle", postcode: "NE4 7AB" }, "NE4")).toBe(FEE);
  });

  it("till orders, which fill the column instead of the blob", () => {
    const driver = { startupFee: "0", postcodeFees: [{ postcode: "NE15", fee: FEE }] };
    const owed = summariseStops(driver, [
      {
        status: "DELIVERED" as any,
        deliveredAt: new Date("2026-11-02T18:00:00Z"),
        order: { total: 20, paymentMethod: "CASH", postcode: "NE15 8AB", deliveryAddress: null },
      },
    ]);
    expect(owed.deliveryFeeTotal).toBe(FEE);
  });
});
