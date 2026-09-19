import { transformGlovoOrder } from "../glovo-order.transformer";
import {
  glovoLocalToDate,
  glovoMoney,
  glovoStatusFor,
  mapGlovoCancellationStatus,
  mapGlovoFulfilment,
} from "../glovo-order.mappers";
import {
  GLOVO_COMBO_ORDER,
  GLOVO_COURIER_ORDER,
  GLOVO_MARKETPLACE_ORDER,
  GLOVO_PICKUP_ORDER,
} from "./glovo-order.fixtures";

// Glovo order payload → CanonicalOrder. Every expectation here comes from the
// restaurant Partners API spec's own wording; see the fixtures file.

describe("glovoMoney — orders are integer CENTS", () => {
  it("divides by 100 (1000 → 10.00), never passes the raw number through", () => {
    expect(glovoMoney(1000)).toBe(10);
    expect(glovoMoney(3080)).toBe(30.8);
  });
  it("treats null (a Glovo-courier order's delivery_fee) as 0", () => {
    expect(glovoMoney(null)).toBe(0);
    expect(glovoMoney(undefined)).toBe(0);
  });
});

describe("glovoLocalToDate — local wall-clock + a string offset", () => {
  it("subtracts utc_offset_minutes: 14:24:53 at +60 is 13:24:53Z", () => {
    expect(glovoLocalToDate("2018-06-08 14:24:53", "60")!.toISOString()).toBe(
      "2018-06-08T13:24:53.000Z",
    );
  });
  it("returns null for garbage rather than an Invalid Date", () => {
    expect(glovoLocalToDate("not a date", "60")).toBeNull();
  });
});

describe("mapGlovoFulfilment", () => {
  it("no address and not collecting → Glovo courier, PLATFORM", () => {
    expect(mapGlovoFulfilment(GLOVO_COURIER_ORDER)).toEqual({
      fulfillmentType: "PLATFORM_COURIER",
      deliveryType: "PLATFORM",
      marketplace: false,
    });
  });
  it("a delivery address → marketplace, the store delivers (MERCHANT)", () => {
    expect(mapGlovoFulfilment(GLOVO_MARKETPLACE_ORDER).fulfillmentType).toBe("MERCHANT_DELIVERY");
    expect(mapGlovoFulfilment(GLOVO_MARKETPLACE_ORDER).deliveryType).toBe("MERCHANT");
  });
  it("is_picked_up_by_customer → PICKUP", () => {
    expect(mapGlovoFulfilment(GLOVO_PICKUP_ORDER).fulfillmentType).toBe("PICKUP");
  });
  it("a marketplace total with an empty address is still marketplace, not a phantom courier", () => {
    const o = { ...GLOVO_MARKETPLACE_ORDER, delivery_address: null };
    expect(mapGlovoFulfilment(o).fulfillmentType).toBe("MERCHANT_DELIVERY");
  });
});

describe("transformGlovoOrder — Glovo-courier order", () => {
  const { canonical, warnings } = transformGlovoOrder(GLOVO_COURIER_ORDER, { country: "ES" })!;

  it("uses order_id for idempotency and order_code as the number staff see", () => {
    expect(canonical.externalId).toBe("12345");
    expect(canonical.displayId).toBe("BA7DWBUL");
    expect(canonical.platform).toBe("GLOVO");
    expect(canonical.orderSource).toBe("GLOVO");
    expect(canonical.integrationSource).toBe("DIRECT");
  });

  it("prices each line in major units: unit excludes attributes, total includes them × qty", () => {
    const burger = canonical.items[0]!;
    expect(burger.quantity).toBe(2);
    expect(burger.unitPrice).toBe(10);
    // (10.00 + 3.00 extra meat + 0 water) × 2
    expect(burger.totalPrice).toBe(26);
    expect(burger.modifiers.map((m) => m.name)).toEqual(["Extra meat", "Water (33 cl)"]);
    expect(burger.externalId).toBe("pd1");
  });

  it("takes the totals from Glovo, which agree with the lines", () => {
    expect(canonical.subtotal).toBe(30.8);
    expect(canonical.total).toBe(30.8);
    expect(canonical.deliveryFee).toBe(0);
    expect(warnings.join(" ")).not.toMatch(/differ/);
  });

  it("drops the literal \"N/A\" phone instead of printing it", () => {
    expect(canonical.customerInfo.name).toBe("Waldo");
    expect(canonical.customerInfo.phone).toBeUndefined();
  });

  it("puts the pick-up code first in the notes, with the allergy flagged", () => {
    expect(canonical.specialInstructions).toMatch(/^Glovo pick-up code 433/);
    expect(canonical.specialInstructions).toContain("ALLERGY: I am allergic to tomato");
    expect(canonical.specialInstructions).toContain("Cutlery requested");
  });

  it("has no address (Glovo sends none for its own couriers) and a pickup ETA in UTC", () => {
    expect(canonical.deliveryAddress).toBeUndefined();
    expect((canonical as any).courierPickupEtaAt.toISOString()).toBe("2018-06-08T13:45:44.000Z");
  });

  it("DELAYED payment is Glovo's invoice → PAID; the courier is carried for the courier columns", () => {
    expect((canonical.metadata as any).paymentStatus).toBe("PAID");
    expect((canonical.metadata as any).courier).toEqual({ name: "Flash", phone: "+34666666666" });
    expect((canonical.metadata as any).glovo.storeId).toBe("OH-TESTSTORE1");
  });

  it("is never scheduled — Glovo dispatches when the kitchen should start", () => {
    expect(canonical.scheduledFor).toBeUndefined();
  });
});

describe("transformGlovoOrder — marketplace order", () => {
  const { canonical } = transformGlovoOrder(GLOVO_MARKETPLACE_ORDER, { country: "ES" })!;

  it("uses total_customer_to_pay as the total, with the fees itemised", () => {
    expect(canonical.total).toBe(34.5);
    expect(canonical.deliveryFee).toBe(2.5);
    expect(canonical.serviceCharge).toBe(1.2);
  });

  it("builds the address in the SHOP's country, not the GB default", () => {
    expect(canonical.deliveryAddress).toEqual(
      expect.objectContaining({
        line1: "Fake Street 123",
        city: "Barcelona",
        postcode: "08001",
        country: "ES",
        coordinates: { lat: 41.3971955, lng: 2.2001737 },
      }),
    );
  });

  it("CASH means the courier pays the store at pickup — outstanding, and said on the ticket", () => {
    expect((canonical.metadata as any).paymentMethod).toBe("CASH");
    expect((canonical.metadata as any).paymentStatus).toBe("PENDING");
    expect(canonical.specialInstructions).toContain("pays the store in cash");
    expect(canonical.customerInfo.phone).toBe("+34611222333");
  });
});

describe("transformGlovoOrder — combo + promotion", () => {
  const { canonical } = transformGlovoOrder(GLOVO_COMBO_ORDER, { country: "ES" })!;

  it("lists the combo's parts with their own attributes indented beneath", () => {
    const mods = canonical.items[0]!.modifiers;
    expect(mods.map((m) => `${m.depth ?? 0}:${m.name}`)).toEqual([
      "0:Very large!",
      "0:Cheese Burger",
      "1:Extra cheese",
      "0:Fries",
      "0:Coke",
      "1:Extra ice",
    ]);
    expect(canonical.items[0]!.totalPrice).toBe(105);
  });

  it("discount = before-promo total minus discounted_products_total", () => {
    expect(canonical.subtotal).toBe(105);
    expect(canonical.discount).toBe(15);
    expect(canonical.total).toBe(90);
  });
});

describe("Glovo status mapping", () => {
  it("READY only goes to Glovo for courier and customer-pickup orders", () => {
    expect(glovoStatusFor("READY", "PLATFORM_COURIER")).toBe("READY_FOR_PICKUP");
    expect(glovoStatusFor("READY", "PICKUP")).toBe("READY_FOR_PICKUP");
    expect(glovoStatusFor("READY", "MERCHANT_DELIVERY")).toBeNull();
  });
  it("OUT_FOR_DELIVERY is marketplace-only; COMPLETED is pickup-only", () => {
    expect(glovoStatusFor("OUT_FOR_DELIVERY", "MERCHANT_DELIVERY")).toBe("OUT_FOR_DELIVERY");
    expect(glovoStatusFor("OUT_FOR_DELIVERY", "PLATFORM_COURIER")).toBeNull();
    expect(glovoStatusFor("COMPLETED", "PICKUP")).toBe("PICKED_UP_BY_CUSTOMER");
    expect(glovoStatusFor("COMPLETED", "PLATFORM_COURIER")).toBeNull();
  });
  it("cancel has no Glovo equivalent", () => {
    expect(glovoStatusFor("CANCELLED", "PLATFORM_COURIER")).toBeNull();
  });
  it("store-side reasons are REJECTED, the rest CANCELLED", () => {
    expect(mapGlovoCancellationStatus("PRODUCTS_NOT_AVAILABLE")).toBe("REJECTED");
    expect(mapGlovoCancellationStatus("USER_ERROR")).toBe("CANCELLED");
  });
});
