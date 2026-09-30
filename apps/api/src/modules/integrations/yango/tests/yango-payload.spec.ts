import {
  buildCheckPriceBody,
  buildCreateBody,
  orderWeightKg,
  toYangoPhone,
  yangoMoney,
  DEST_POINT,
  SOURCE_POINT,
} from "../yango-payload";
import { toYangoCoords } from "../yango-client.service";

// The Yango (Yandex) express API has several shapes that are wrong-by-default
// and fail with nothing more helpful than unknown_zone or validation_error.
// Each is pinned here.

const DUBAI_SHOP = { lat: 25.1972, lng: 55.2396 };
const JLT = { lat: 25.0692, lng: 55.1438 };
const route = {
  pickup: DUBAI_SHOP,
  pickupAddress: "Al Wasl Road 12, Dubai",
  dropoff: JLT,
  dropoffAddress: "JLT Cluster D, Tower 3, Dubai",
};
const order = (over: Record<string, any> = {}) => ({
  id: "ord_1234567890",
  displayId: "1042",
  total: 86.5,
  customerName: "Aisha",
  customerPhone: "050 987 6543",
  items: [{ quantity: 2 }, { quantity: 1 }],
  specialInstructions: "Call on arrival",
  ...over,
});
const location = { name: "Shawarma House", phone: "+971 4 123 4567" };

function create(over: Record<string, any> = {}) {
  return buildCreateBody({
    order: order(over),
    location,
    route,
    taxiClass: "courier",
    currency: "AED",
    contactEmail: "ops@shop.ae",
    shopPhone: "+97141234567",
    customerPhone: "+971509876543",
    callbackUrl: "https://api.example/api/v1/webhooks/yango/tok?",
  });
}

describe("coordinates are [longitude, latitude]", () => {
  it("flips our {lat,lng} into Yango's [lon, lat]", () => {
    expect(toYangoCoords(DUBAI_SHOP)).toEqual([55.2396, 25.1972]);
  });

  it("check-price and create both send [lon, lat] — reversed, a Dubai drop-off lands in the Indian Ocean", () => {
    const cp = buildCheckPriceBody(order(), route, "courier");
    expect(cp.route_points[0]!.coordinates).toEqual([55.2396, 25.1972]);
    expect(cp.route_points[1]!.coordinates).toEqual([55.1438, 25.0692]);
    const cr = create();
    expect(cr.route_points[0]!.address.coordinates).toEqual([55.2396, 25.1972]);
    expect(cr.route_points[1]!.address.coordinates).toEqual([55.1438, 25.0692]);
  });
});

describe("check-price and create are two different shapes", () => {
  it("check-price: route points use `id`, flat coordinates/fullname, items use `dropoff_point`", () => {
    const cp: any = buildCheckPriceBody(order(), route, "courier");
    expect(cp.route_points[0]).toEqual({
      id: SOURCE_POINT,
      coordinates: [55.2396, 25.1972],
      fullname: "Al Wasl Road 12, Dubai",
    });
    expect(cp.items[0].dropoff_point).toBe(DEST_POINT);
    expect(cp.items[0].droppof_point).toBeUndefined();
    expect(cp.requirements).toEqual({ taxi_class: "courier" });
    expect(cp.client_requirements).toBeUndefined();
  });

  it("create: route points use `point_id` + address, items use the misspelt `droppof_point`", () => {
    const cr: any = create();
    expect(cr.route_points[0].point_id).toBe(SOURCE_POINT);
    expect(cr.route_points[0].id).toBeUndefined();
    expect(cr.items[0].droppof_point).toBe(DEST_POINT);
    expect(cr.items[0].dropoff_point).toBeUndefined();
    expect(cr.items[0].pickup_point).toBe(SOURCE_POINT);
    expect(cr.client_requirements).toEqual({ taxi_class: "courier" });
  });
});

describe("create body details", () => {
  it("puts the required email on the SOURCE contact only", () => {
    const cr = create();
    expect(cr.route_points[0]!.contact).toEqual({
      name: "Shawarma House",
      phone: "+97141234567",
      email: "ops@shop.ae",
    });
    expect(cr.route_points[1]!.contact.email).toBeUndefined();
  });

  it("skips the SMS handover code at both ends (default would demand one at the counter)", () => {
    const cr = create();
    expect(cr.route_points.map((p) => p.skip_confirmation)).toEqual([true, true]);
  });

  it("external_order_id only on the destination (Yango rejects it elsewhere)", () => {
    const cr = create();
    expect(cr.route_points[0]!.external_order_id).toBeUndefined();
    expect(cr.route_points[1]!.external_order_id).toBe("1042");
  });

  it("money is a decimal STRING in the currency's precision", () => {
    const cr = create();
    expect(cr.items[0]!.cost_value).toBe("86.50");
    expect(cr.items[0]!.cost_currency).toBe("AED");
    expect(cr.route_points[1]!.external_order_cost).toEqual({ value: "86.50", currency: "AED" });
    expect(yangoMoney(12.3456, "KWD")).toBe("12.346");
    expect(yangoMoney(undefined, "AED")).toBe("0.00");
  });

  it("points 1 → 2 in visit order, source then destination", () => {
    const cr = create();
    expect(cr.route_points.map((p) => [p.type, p.visit_order])).toEqual([
      ["source", 1],
      ["destination", 2],
    ]);
  });

  it("passes the callback URL through and asks Yango to text the customer", () => {
    const cr = create();
    expect(cr.callback_properties?.callback_url.endsWith("?")).toBe(true);
    expect(cr.skip_client_notify).toBe(false);
  });

  it("carries delivery notes to the drop-off point", () => {
    expect(create().route_points[1]!.address.comment).toBe("Call on arrival");
    expect(create({ specialInstructions: "" }).route_points[1]!.address.comment).toBeUndefined();
  });

  it("falls back to a short id when the order has no display ref", () => {
    const cr = create({ displayId: null, orderNumber: undefined });
    expect(cr.items[0]!.title).toBe("Order 34567890");
    expect(cr.route_points[1]!.external_order_id).toBe("34567890");
  });
});

describe("weight", () => {
  it("~500g per unit, floored at 500g", () => {
    expect(orderWeightKg(order(), "courier")).toBe(1.5);
    expect(orderWeightKg({ items: [] }, "courier")).toBe(0.5);
  });
  it("capped at the class limit rather than refused as too heavy", () => {
    const big = { items: [{ quantity: 60 }] };
    expect(orderWeightKg(big, "courier")).toBe(10);
    expect(orderWeightKg(big, "express")).toBe(20);
  });
});

describe("phones must be international (+…)", () => {
  it.each([
    ["050 987 6543", "+971509876543"],
    ["0509876543", "+971509876543"],
    ["971509876543", "+971509876543"],
    ["00971509876543", "+971509876543"],
    ["+971 50-987-6543", "+971509876543"],
    ["509876543", "+971509876543"],
    ["+44 7700 900123", "+447700900123"],
  ])("%s → %s", (raw, want) => {
    expect(toYangoPhone(raw)).toBe(want);
  });
  it.each([[""], ["   "], [null], [undefined], ["+123"], ["abc"]])("rejects %p", (raw) => {
    expect(toYangoPhone(raw as any)).toBeNull();
  });
});
