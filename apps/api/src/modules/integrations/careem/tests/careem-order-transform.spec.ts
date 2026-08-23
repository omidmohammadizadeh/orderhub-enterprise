import {
  transformCareemOrder,
  computeCareemTotal,
  careemTotalDiscount,
  flattenCareemModifiers,
  type CareemNameLookup,
  type CareemOrder,
} from "../careem-order.transformer";

// Built from Careem's documented payloads, not from prose — they publish
// complete ORDER_CREATED and ORDER_STATUS_UPDATED examples, a full OrderItem
// schema, and a pricing section that works an example through to a total.
//
// The first test below reproduces THEIR arithmetic. If our maths and theirs
// ever diverge, this fails rather than a customer being charged the wrong
// amount.

const names: CareemNameLookup = {
  item: (id) =>
    ({
      "00ccc1db": "Chicken Shawarma",
      "345": "Beef Burger",
    })[id],
  option: (id) =>
    ({
      "8c7102d7": "Extra garlic",
      "129": "BBQ sauce",
      "130": "Ketchup",
    })[id],
};

describe("computeCareemTotal — Careem's own worked example", () => {
  // From their docs, verbatim: original 45.67, 0% tax, merchant promotion
  // 18.27, no promo code, delivery 7, service 1 → total 35.4.
  it("reproduces the documented total of 35.4", () => {
    expect(
      computeCareemTotal({
        original_total_price: 45.67,
        tax_percentage: 0,
        merchant_discount_amount: 18.27,
        careem_discount_amount: 0,
        merchant_promo_amount: 0,
        careem_promo_amount: 0,
        delivery_fee: 7,
        service_fee: 1,
      }),
    ).toBe(35.4);
  });

  it("applies tax BEFORE discounts, in their order", () => {
    // Their formula taxes the basket first, then subtracts promotions, then
    // promo codes. Doing it the other way round changes the answer, and the
    // difference is small enough to go unnoticed for a long time.
    expect(
      computeCareemTotal({
        original_total_price: 100,
        tax_percentage: 5,
        merchant_discount_amount: 10,
        delivery_fee: 0,
        service_fee: 0,
      }),
    ).toBe(95); // 100 + 5 = 105, − 10 = 95
  });

  it("counts promotions and promo codes as separate stages", () => {
    expect(
      computeCareemTotal({
        original_total_price: 50,
        tax_percentage: 0,
        merchant_discount_amount: 5,
        careem_discount_amount: 5,
        merchant_promo_amount: 4,
        careem_promo_amount: 6,
        delivery_fee: 2,
        service_fee: 1,
      }),
    ).toBe(33); // 50 − 10 − 10 + 3
  });
});

describe("careemTotalDiscount", () => {
  it("sums both sides of both discount kinds", () => {
    // Careem and the merchant each fund part of a promotion, and separately
    // part of a promo code. Our books want the customer-visible total.
    expect(
      careemTotalDiscount({
        merchant_discount_amount: 4,
        careem_discount_amount: 6,
        merchant_promo_amount: 2.5,
        careem_promo_amount: 1.5,
      }),
    ).toBe(14);
  });
});

describe("flattenCareemModifiers", () => {
  it("flattens nested option groups and records the depth", () => {
    // Careem supports modifiers hanging off modifiers — a sauce for the side
    // that came with the meal. Our list is flat, so depth is what lets a
    // ticket indent it back into a tree.
    const flat = flattenCareemModifiers(
      [
        {
          id: "30",
          options: [
            {
              id: "129",
              quantity: 2,
              total_price: 2.25,
              groups: [{ id: "31", options: [{ id: "130", quantity: 1, total_price: 0 }] }],
            },
          ],
        },
      ],
      names,
    );
    expect(flat).toEqual([
      { name: "BBQ sauce", price: 2.25, quantity: 2, depth: 0 },
      { name: "Ketchup", price: 0, quantity: 1, depth: 1 },
    ]);
  });

  it("falls back to the raw id rather than dropping an unresolvable option", () => {
    // A ticket line reading "d92f11-fa2" is ugly. A missing line is worse —
    // the kitchen makes the wrong thing and nobody knows why.
    const flat = flattenCareemModifiers(
      [{ id: "g", options: [{ id: "unknown-option", quantity: 1, total_price: 1 }] }],
      names,
    );
    expect(flat[0]!.name).toBe("unknown-option");
  });
});

describe("transformCareemOrder", () => {
  const base: CareemOrder = {
    id: 62503433,
    status: "pending",
    merchant_pay_type: "prepaid",
    delivery_type: "careem",
    branch: { id: "branch-1", brand_id: "brand-1", name: "Subway" },
    notes: "",
    price: {
      original_total_price: 4.7,
      merchant_discount_amount: 2.3,
      careem_discount_amount: 0,
      merchant_promo_amount: 0,
      careem_promo_amount: 0,
      tax_percentage: 0,
      total_taxable_price: 4.4,
      delivery_fee: 2,
      service_fee: 0.15,
    },
    customer: { name: "", phone_number: 0, payment_type: "" },
    cash_in: 0,
    items: [
      {
        id: "00ccc1db",
        quantity: 2,
        unit_price: 1.95,
        item_price: 3.9,
        total_price: 4.7,
        discount: 0,
        notes: "Please don't ring the door bell",
        groups: [
          {
            id: "fc47dca5",
            options: [{ id: "8c7102d7", quantity: 2, total_price: 0.4 }],
          },
        ],
      },
    ],
    created_at: "2023-06-18T22:30:29Z",
    is_scheduled: false,
  };

  it("uses Careem's total verbatim rather than deriving one", () => {
    // Recomputing from parts is how a marketplace order ends up a few fils out
    // and nobody notices for a month. computeCareemTotal exists to CHECK it.
    const out = transformCareemOrder(base, names);
    expect(out.total).toBe(4.4);
    expect(out.deliveryFee).toBe(2);
    // Goods only — Careem's total already contains the fees.
    expect(out.subtotal).toBe(2.25);
  });

  it("resolves item and option names from our own menu", () => {
    // Careem sends ids and no names at all. Without this a ticket prints UUIDs.
    const out = transformCareemOrder(base, names);
    expect(out.items[0]!.name).toBe("Chicken Shawarma");
    expect(out.items[0]!.modifiers[0]!.name).toBe("Extra garlic");
    // The published catalog id is kept so KDS rules and reports can find our
    // MenuItem again.
    expect(out.items[0]!.sku).toBe("00ccc1db");
  });

  it("treats a Careem-delivered order as platform courier, with no address", () => {
    // Their courier collects, so the kitchen is preparing for collection. The
    // blank customer block is Careem keeping their customer's details — by
    // design, not missing data.
    const out = transformCareemOrder(base, names);
    expect(out.fulfillmentType).toBe("PLATFORM_COURIER");
    expect(out.deliveryAddress).toBeUndefined();
    expect(out.customerInfo.name).toBe("Careem customer");
    expect(out.customerInfo.phone).toBeUndefined();
  });

  it("keeps the address and marks it delivery for self-delivery orders", () => {
    const out = transformCareemOrder(
      {
        ...base,
        delivery_type: "merchant",
        customer: {
          name: "Derek Falcon",
          phone_number: 971588371761,
          payment_type: "cash",
          address: {
            name: "Work",
            number: "G04",
            building: "204",
            street: "3075 Dye Street",
            area: "Marina",
            city: "Dubai",
            location: { lat: "25.07", lng: "55.13" },
          },
        },
      },
      names,
    );
    expect(out.fulfillmentType).toBe("DELIVERY");
    expect(out.customerInfo.name).toBe("Derek Falcon");
    expect(out.customerInfo.phone).toBe("971588371761");
    expect(out.deliveryAddress).toMatchObject({
      line1: "G04, 204, 3075 Dye Street",
      city: "Dubai",
      area: "Marina",
      country: "AE",
      coordinates: { lat: 25.07, lng: 55.13 },
    });
  });

  it("treats phone_number 0 as absent, not as the number zero", () => {
    // It arrives as a NUMBER, and 0 is their "not provided".
    const out = transformCareemOrder(
      { ...base, customer: { name: "X", phone_number: 0 } },
      names,
    );
    expect(out.customerInfo.phone).toBeUndefined();
  });

  it("merges notes and merchant instructions into one instruction line", () => {
    const out = transformCareemOrder(
      {
        ...base,
        notes: "extra ketchup",
        metadata: {
          order_instructions: {
            merchant_notes: "less spicy",
            merchant_instructions: [
              { label: "INCLUDE_CUTLERY", name_localized: { en: "Include Cutlery" } },
            ],
          },
        },
      },
      names,
    );
    expect(out.specialInstructions).toBe(
      "extra ketchup · less spicy · Include Cutlery",
    );
  });

  it("carries the scheduled slot start when the order is scheduled", () => {
    const out = transformCareemOrder(
      {
        ...base,
        is_scheduled: true,
        delivery: {
          delivery_mode: "scheduled",
          schedule_detail: { time_slot: { start: "2025-05-01T09:00:00Z" } },
        },
      },
      names,
    );
    expect(out.scheduledFor?.toISOString()).toBe("2025-05-01T09:00:00.000Z");
  });

  it("reports tax as a component, since Careem prices include it", () => {
    const out = transformCareemOrder(
      { ...base, price: { ...base.price, tax_percentage: 5, original_total_price: 100 } },
      names,
    );
    expect(out.taxAmount).toBe(5);
  });

  it("keeps the raw payload for diffing against a real order", () => {
    // This transformer is written from documented examples. Careem is the
    // third marketplace whose docs have drifted from their payloads.
    const out = transformCareemOrder(base, names);
    expect((out.metadata as Record<string, unknown>).careemRaw).toEqual(base);
    expect((out.metadata as Record<string, unknown>).cashIn).toBe(0);
  });

  it("dedupes on Careem's order id", () => {
    const out = transformCareemOrder(base, names);
    expect(out.externalId).toBe("62503433");
    expect(out.platform).toBe("CAREEM");
    expect(out.displayId).toBe("CA-62503433");
  });
});

// Order.deliveryType is MERCHANT | PLATFORM and it is not decoration: PLATFORM
// hands the post-READY chain to the marketplace's courier, MERCHANT walks the
// operator all the way to delivered. Careem's own word ("careem"/"merchant")
// is not that vocabulary, and writing it through unmapped made every
// Careem-delivered order read as the shop's own delivery.
describe("transformCareemOrder — who is actually driving", () => {
  const names = { item: () => "Pizza", option: () => "Cheese" };
  const ctx = { tenantId: "t1", locationId: "loc-1", brandId: "b1" } as never;

  const order = (over: Record<string, unknown> = {}) =>
    ({
      id: 1,
      status: "pending",
      branch: { id: "loc-1", name: "Shop", brand_id: "b1" },
      price: { original_total_price: 10, total_taxable_price: 10 },
      items: [{ id: "i1", quantity: 1, price: 10, total_price: 10 }],
      ...over,
    }) as never;

  it("marks a Careem-delivered order PLATFORM", () => {
    const out = transformCareemOrder(order({ delivery_type: "careem" }), names, ctx);
    expect((out.metadata as any).deliveryType).toBe("PLATFORM");
    expect(out.fulfillmentType).toBe("PLATFORM_COURIER");
  });

  it("marks a self-delivery order MERCHANT", () => {
    const out = transformCareemOrder(order({ delivery_type: "merchant" }), names, ctx);
    expect((out.metadata as any).deliveryType).toBe("MERCHANT");
    expect(out.fulfillmentType).toBe("DELIVERY");
  });

  it("keeps Careem's own word alongside, for support conversations", () => {
    const out = transformCareemOrder(order({ delivery_type: "careem" }), names, ctx);
    expect((out.metadata as any).careemDeliveryType).toBe("careem");
  });

  it("treats an unknown delivery_type as Careem's, not the shop's", () => {
    // Careem deliver the overwhelming majority. Guessing MERCHANT would put a
    // kitchen on the hook for a driver that was never theirs to find.
    const out = transformCareemOrder(order({ delivery_type: undefined }), names, ctx);
    expect((out.metadata as any).deliveryType).toBe("PLATFORM");
  });
});
