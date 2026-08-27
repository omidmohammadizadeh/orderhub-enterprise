import { transformJetOrder } from "../jet-order.transformer";
import {
  COLLECTION_BY_CUSTOMER,
  DELIVERY_BY_MERCHANT,
  DELIVERY_BY_PARTNER,
} from "./jet-order.fixtures";
import {
  classifyJetFailure,
  jetItemSignature,
  jetMoney,
  jetPosLocationIdFrom,
  mapJetCancellationStatus,
  mapJetDriverStatus,
  mapJetFulfilment,
} from "../jet-order.mappers";

// Transformer behaviour, asserted against the spec's own worked examples.
//
// The cases that matter most are the ones where JET differs from every other
// marketplace we integrate: items carry no quantity, promotional items are
// held OUTSIDE the items array, and the driver tip is an adjustment with
// nowhere to live on our Order.

describe("mapJetFulfilment", () => {
  it("maps the three documented types", () => {
    expect(mapJetFulfilment("collection-by-customer")).toEqual({
      fulfillmentType: "PICKUP",
      deliveryType: null,
    });
    expect(mapJetFulfilment("delivery-by-merchant")).toEqual({
      fulfillmentType: "MERCHANT_DELIVERY",
      deliveryType: "MERCHANT",
    });
    expect(mapJetFulfilment("delivery-by-delivery-partner")).toEqual({
      fulfillmentType: "PLATFORM_COURIER",
      deliveryType: "PLATFORM",
    });
  });

  it("treats an unknown type as a partner delivery, not a collection", () => {
    // Deliberate: calling a delivery a collection strands the food with nobody
    // coming for it. The reverse only shows an extra gated step.
    expect(mapJetFulfilment("something-new").fulfillmentType).toBe(
      "PLATFORM_COURIER",
    );
    expect(mapJetFulfilment(undefined).deliveryType).toBe("PLATFORM");
  });
});

describe("jetMoney", () => {
  it("converts minor units to major units with no heuristics", () => {
    expect(jetMoney(1950)).toBe(19.5);
    expect(jetMoney(5)).toBe(0.05);
    // 150 is £1.50, NOT £150 — a "is this already pounds?" guess is how a
    // £19.50 order becomes a £0.20 one.
    expect(jetMoney(150)).toBe(1.5);
    expect(jetMoney(0)).toBe(0);
    expect(jetMoney(undefined)).toBe(0);
    expect(jetMoney("abc")).toBe(0);
  });
});

describe("jetPosLocationIdFrom", () => {
  it("prefers posLocationId and reports which field answered", () => {
    expect(jetPosLocationIdFrom(DELIVERY_BY_PARTNER)).toEqual({
      value: "AKZ12",
      field: "posLocationId",
    });
  });

  it("falls back to JET's own location id, flagging the misconfiguration", () => {
    const { value, field } = jetPosLocationIdFrom({ location: { id: 1296 } });
    expect(value).toBe("1296");
    expect(field).toBe("location.id");
  });

  it("returns null when nothing routable is present", () => {
    expect(jetPosLocationIdFrom({}).value).toBeNull();
  });
});

describe("transformJetOrder — delivery by delivery partner", () => {
  const result = transformJetOrder(DELIVERY_BY_PARTNER)!;
  const c = result.canonical;

  it("keys on JET's order id and shows the customer-facing reference", () => {
    expect(c.externalId).toBe("38bbeb45-f520-4438-a44f-0fcdbb29e166");
    // Staff are asked for "22721763" at the door, not for a UUID.
    expect(c.displayId).toBe("22721763");
    expect(c.platform).toBe("JUST_EAT");
    expect(c.integrationSource).toBe("DIRECT");
    expect(c.viaHubrise).toBe(false);
  });

  it("gates the post-READY steps behind the platform courier", () => {
    expect(c.fulfillmentType).toBe("PLATFORM_COURIER");
    expect((c.metadata as any).deliveryType).toBe("PLATFORM");
  });

  it("carries modifier options through as line modifiers", () => {
    const burger = c.items.find((i) => i.name === "Cheeseburger")!;
    expect(burger.unitPrice).toBe(17);
    expect(burger.sku).toBe("M2");
    expect(burger.modifiers).toEqual([
      { name: "Extra Sauce", price: 1, quantity: 1 },
    ]);
  });

  it("merges promotional items into the kitchen's item list", () => {
    // The spec: when an item-level promotion applies, the affected items
    // "won't appear on the top level items array, but on the promotion.items
    // one". Reading only the top level means the free item is never made and
    // the customer gets a short bag.
    const promo = c.items.find((i) => i.name === "Crispy Chicken Twist");
    expect(promo).toBeDefined();
    expect(promo!.notes).toContain("FREE_ITEM_MIN_BASKET");
    expect(result.warnings.join(" ")).toContain("promotional item");
  });

  it("takes totals from JET rather than re-summing the lines", () => {
    expect(c.subtotal).toBe(21.6);
    expect(c.total).toBe(21.6);
    expect(c.taxAmount).toBe(3.6);
  });

  it("replaces a fully masked customer name with a channel label", () => {
    expect(c.customerInfo.name).toBe("Just Eat Customer");
    expect(c.customerInfo.name).not.toContain("*");
    expect(result.warnings.join(" ")).toContain("masked");
  });

  it("drops the placeholder .hidden email rather than failing validation", () => {
    expect((c.customerInfo as any).email).toBeUndefined();
  });

  it("keeps the assigned driver on the courier metadata, not as the customer", () => {
    expect((c.metadata as any).courier).toEqual({
      name: "John Smith",
      phone: "555-111-3344",
      phoneAccessCode: null,
    });
    expect(c.customerInfo.name).not.toContain("John Smith");
  });

  it("records the promotion for reporting without double-counting the discount", () => {
    // discount comes from the `discount` ADJUSTMENT; the promotion's own
    // discount_value is informational. This fixture has no discount
    // adjustment, so the order discount is zero even though a promo applied.
    expect(c.discount).toBe(0);
    expect((c.metadata as any).jet.promotions[0]).toMatchObject({
      type: "FREE_ITEM_MIN_BASKET",
      discountValue: 4.19,
    });
  });
});

describe("transformJetOrder — delivery by merchant", () => {
  const c = transformJetOrder(DELIVERY_BY_MERCHANT)!.canonical;

  it("lets staff drive the delivery themselves", () => {
    expect(c.fulfillmentType).toBe("MERCHANT_DELIVERY");
    expect((c.metadata as any).deliveryType).toBe("MERCHANT");
  });

  it("reads the flat delivery address with coordinates", () => {
    expect(c.deliveryAddress).toEqual({
      line1: "1234 Spicy Street",
      line2: undefined,
      city: "Winnipeg",
      postcode: "R3B 0P4",
      country: "GB",
      coordinates: { lat: 49.898498728223224, lng: -97.13560152293131 },
    });
  });

  it("splits the adjustments into their own money fields", () => {
    expect(c.deliveryFee).toBe(2.4);
    expect((c.metadata as any).serviceCharge).toBe(0.15);
    expect(c.total).toBe(8.55);
  });

  it("marks a cash order as still owing", () => {
    expect((c.metadata as any).paymentMethod).toBe("CASH");
    expect((c.metadata as any).paymentStatus).toBe("PENDING");
  });

  it("joins the kitchen and delivery notes onto one instruction line", () => {
    expect(c.specialInstructions).toBe(
      "It's the blue house at the end of the block.",
    );
  });

  it("keeps a real customer name", () => {
    expect(c.customerInfo.name).toBe("John Doe");
    expect(c.customerInfo.phone).toBe("555-113-0000");
  });
});

describe("transformJetOrder — collection by customer", () => {
  const c = transformJetOrder(COLLECTION_BY_CUSTOMER)!.canonical;

  it("takes the customer from `collector`, not `delivery`", () => {
    expect(c.fulfillmentType).toBe("PICKUP");
    expect(c.customerInfo.name).toBe("John Doe");
    expect(c.deliveryAddress).toBeUndefined();
  });

  it("keeps the call-centre PIN so staff can actually reach them", () => {
    expect((c.customerInfo as any).phoneAccessCode).toBe("1234567890");
  });

  it("sets the ready-for time from collect_at", () => {
    expect(c.scheduledFor?.toISOString()).toBe(
      new Date(1606780980 * 1000).toISOString(),
    );
  });

  it("joins kitchen and collection notes", () => {
    expect(c.specialInstructions).toBe(
      "Please add extra cheese to the pizza — I will be wearing a green dress",
    );
  });
});

describe("transformJetOrder — quantity by repetition", () => {
  // JET's item schema has NO quantity field. Three burgers arrive as three
  // identical objects; without collapsing, the ticket reads "Cheeseburger x1"
  // three times and every item count in reporting is wrong.
  const threeBurgers = {
    ...DELIVERY_BY_PARTNER,
    promotions: [],
    items: [
      { name: "Cheeseburger", plu: "M2", price: 1700, notes: "", children: [] },
      { name: "Cheeseburger", plu: "M2", price: 1700, notes: "", children: [] },
      { name: "Cheeseburger", plu: "M2", price: 1700, notes: "", children: [] },
    ],
  };

  it("collapses identical repeats into one quantified line", () => {
    const c = transformJetOrder(threeBurgers)!.canonical;
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.quantity).toBe(3);
    expect(c.items[0]!.unitPrice).toBe(17);
    expect(c.items[0]!.totalPrice).toBe(51);
  });

  it("keeps lines the kitchen must treat differently apart", () => {
    const c = transformJetOrder({
      ...threeBurgers,
      items: [
        { name: "Cheeseburger", plu: "M2", price: 1700, notes: "", children: [] },
        { name: "Cheeseburger", plu: "M2", price: 1700, notes: "no pickles", children: [] },
        {
          name: "Cheeseburger",
          plu: "M2",
          price: 1700,
          notes: "",
          children: [{ name: "Extra Sauce", plu: "R3", price: 100 }],
        },
      ],
    })!.canonical;
    // Same product, three genuinely different builds.
    expect(c.items).toHaveLength(3);
    expect(c.items.every((i) => i.quantity === 1)).toBe(true);
  });

  it("preserves basket order", () => {
    const c = transformJetOrder({
      ...threeBurgers,
      items: [
        { name: "Fries", plu: "F1", price: 300, notes: "", children: [] },
        { name: "Cheeseburger", plu: "M2", price: 1700, notes: "", children: [] },
        { name: "Fries", plu: "F1", price: 300, notes: "", children: [] },
      ],
    })!.canonical;
    expect(c.items.map((i) => i.name)).toEqual(["Fries", "Cheeseburger"]);
    expect(c.items[0]!.quantity).toBe(2);
  });

  it("honours an explicit quantity field if one ever appears", () => {
    // Defensive: if a real payload carries quantity, collapsing repeats on top
    // of it would multiply the order. Honour it and warn instead.
    const result = transformJetOrder({
      ...threeBurgers,
      items: [
        { name: "Cheeseburger", plu: "M2", price: 1700, notes: "", children: [], quantity: 4 },
      ],
    })!;
    expect(result.canonical.items[0]!.quantity).toBe(4);
    expect(result.warnings.join(" ")).toContain("explicit `quantity`");
  });
});

describe("jetItemSignature", () => {
  it("treats identical builds as one line and different notes as two", () => {
    const base = { plu: "M2", name: "Burger", price: 1700, notes: "", children: [] };
    expect(jetItemSignature(base)).toBe(jetItemSignature({ ...base }));
    expect(jetItemSignature(base)).not.toBe(
      jetItemSignature({ ...base, notes: "no pickles" }),
    );
    expect(jetItemSignature(base)).not.toBe(
      jetItemSignature({ ...base, children: [{ plu: "R3", name: "Sauce", price: 100 }] }),
    );
  });
});

describe("transformJetOrder — the driver tip has nowhere to go", () => {
  it("records the tip in metadata and never on a column that does not exist", () => {
    // Order has no tipAmount column. Writing to one that does not exist is an
    // outage, not a bug — it took online checkout down once already.
    const c = transformJetOrder({
      ...DELIVERY_BY_MERCHANT,
      payment: {
        ...DELIVERY_BY_MERCHANT.payment,
        adjustments: [
          ...DELIVERY_BY_MERCHANT.payment.adjustments,
          { name: "driverTip", price: { inc_tax: 250, tax: 0 } },
        ],
      },
    })!.canonical;
    expect((c.metadata as any).jet.driverTip).toBe(2.5);
    expect((c as any).tipAmount).toBeUndefined();
  });

  it("subtracts a discount adjustment as a positive magnitude", () => {
    const c = transformJetOrder({
      ...DELIVERY_BY_MERCHANT,
      payment: {
        ...DELIVERY_BY_MERCHANT.payment,
        adjustments: [{ name: "discount", price: { inc_tax: 300, tax: 0 } }],
      },
    })!.canonical;
    expect(c.discount).toBe(3);
  });
});

describe("transformJetOrder — refusals", () => {
  it("returns null without an order id, the one unrecoverable case", () => {
    expect(transformJetOrder({ ...DELIVERY_BY_PARTNER, id: undefined })).toBeNull();
    expect(transformJetOrder({})).toBeNull();
  });

  it("still produces an order when items are missing, and warns", () => {
    const result = transformJetOrder({
      ...DELIVERY_BY_PARTNER,
      items: [],
      promotions: [],
    })!;
    expect(result.canonical.items).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("no items");
  });
});

describe("mapJetDriverStatus", () => {
  it("maps the four documented codes onto our courier stages", () => {
    expect(mapJetDriverStatus("driverArrivingAtRestaurant")).toBe("ASSIGNED_DRIVER");
    expect(mapJetDriverStatus("driverAtRestaurant")).toBe("RIDER_ARRIVED");
    expect(mapJetDriverStatus("onItsWay")).toBe("OUT_FOR_DELIVERY");
    expect(mapJetDriverStatus("delivered")).toBe("COMPLETED");
    expect(mapJetDriverStatus("somethingElse")).toBeNull();
  });
});

describe("mapJetCancellationStatus", () => {
  it("separates the shop's own refusals from everything else", () => {
    // Whether the restaurant refused the order or the customer changed their
    // mind is not cosmetic — it drives reporting and whether the cancel counts
    // against the operator.
    expect(mapJetCancellationStatus("restCancelledTooBusy")).toBe("REJECTED");
    expect(mapJetCancellationStatus("restCancelledOutOfStock")).toBe("REJECTED");
    expect(mapJetCancellationStatus("deletedRejectedByRestaurant")).toBe("REJECTED");
    expect(mapJetCancellationStatus("custCancelledChangedMind")).toBe("CANCELLED");
    expect(mapJetCancellationStatus("deletedSystemError")).toBe("CANCELLED");
    expect(mapJetCancellationStatus(undefined)).toBe("CANCELLED");
  });
});

describe("classifyJetFailure", () => {
  it("names a store-mapping problem so the operator fixes the right thing", () => {
    expect(
      classifyJetFailure(new Error('No connected Just Eat restaurant for posLocationId "AKZ12"')).code,
    ).toBe("INCORRECT_SETUP");
  });

  it("names a menu problem", () => {
    expect(classifyJetFailure(new Error("PLU M2 is not on the menu")).code).toBe(
      "MENU_ERROR",
    );
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    // A wrong code sends the operator somewhere useless. Better to say so.
    expect(classifyJetFailure(new Error("connection reset by peer")).code).toBe(
      "UNKNOWN",
    );
  });

  it("always produces a non-empty message (JET 400s a blank one)", () => {
    expect(classifyJetFailure(new Error("")).message).toBeTruthy();
    expect(classifyJetFailure(undefined).message).toBeTruthy();
  });
});

// collect_at appears on TWO order types and means different things on each.
// Per the JET Connect spec: present on delivery-by-delivery-partner and
// collection-by-customer; deliver_at on delivery-by-merchant.
describe("transformJetOrder — the pickup ETA", () => {
  const at = 1787900000; // arbitrary unix seconds

  const order = (type: string) =>
    transformJetOrder(
      {
        id: "o1",
        type,
        posLocationId: "loc-1",
        collect_at: String(at),
        items: [{ name: "Burger", plu: "B1", price: 900, quantity: 1 }],
      } as never,
      { tenantId: "t1", locationId: "loc-1", brandId: "b1" } as never,
    );

  it("uses collect_at as the courier's ETA on a partner-delivered order", () => {
    const out = order("delivery-by-delivery-partner") as any;
    expect(out.canonical.courierPickupEtaAt?.getTime()).toBe(at * 1000);
  });

  it("does NOT on a customer collection — that is the customer coming, not a rider", () => {
    // Same field, different meaning. Writing it into a courier column would
    // invent a rider who does not exist and put an ETA on the board for one.
    const out = order("collection-by-customer") as any;
    expect(out.canonical.courierPickupEtaAt).toBeUndefined();
  });

  it("does NOT on a merchant-delivered order", () => {
    // The shop's own driver. Nobody is sending us an estimate for them.
    const out = order("delivery-by-merchant") as any;
    expect(out.canonical.courierPickupEtaAt).toBeUndefined();
  });
});
