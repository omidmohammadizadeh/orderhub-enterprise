// @nestjs/event-emitter isn't installed in the local worktree test env (it is
// in the deployed build) — the decorator is inert for unit purposes anyway.
jest.mock(
  "@nestjs/event-emitter",
  () => ({ OnEvent: () => () => undefined }),
  { virtual: true },
);

import { DeliverooAdapter } from "../../../webhooks/adapters/deliveroo.adapter";
import { DeliverooOrderSyncService } from "../deliveroo-order-sync.service";

// Regression suite for the LIVE Deliveroo Orders API payload shape (verified
// against the fulfillment-types docs + a real production order that landed
// with £0 totals / wrong fulfillment / no phone):
//   money = { fractional: <minor units>, currency_code } objects
//   fulfillment_type = deliveroo | customer | restaurant | table_service
//   customer = { first_name, contact_number, contact_access_code }
// Plus the Phase BA-4 outbound sync mapping.

const liveOrder = (overrides: Record<string, any> = {}) => ({
  order: {
    id: "gb:order-1",
    display_id: "9962",
    status: "placed",
    fulfillment_type: "deliveroo",
    location_id: "452692",
    items: [
      {
        name: "Cheeseburger",
        operational_name: "CB",
        quantity: 2,
        unit_price: { fractional: 550, currency_code: "GBP" },
        total_price: { fractional: 1100, currency_code: "GBP" },
        modifiers: [
          {
            name: "Extra Cheese",
            quantity: 1,
            unit_price: { fractional: 50, currency_code: "GBP" },
          },
        ],
      },
    ],
    customer: {
      first_name: "Omid",
      contact_number: "+44 20 3699 9999",
      contact_access_code: "1234",
    },
    partner_order_subtotal: { fractional: 1150, currency_code: "GBP" },
    partner_order_total: { fractional: 1150, currency_code: "GBP" },
    ...overrides,
  },
});

describe("DeliverooAdapter — live Orders API payload", () => {
  const adapter = new DeliverooAdapter();

  it("parses fractional money into pounds", () => {
    const c = adapter.normalize(liveOrder(), "loc-1")!;
    expect(c.subtotal).toBe(11.5);
    expect(c.total).toBe(11.5);
    expect(c.items[0]).toMatchObject({
      name: "Cheeseburger",
      quantity: 2,
      unitPrice: 5.5,
      totalPrice: 11,
    });
    expect(c.items[0]!.modifiers[0]).toMatchObject({
      name: "Extra Cheese",
      price: 0.5,
    });
  });

  it("maps fulfillment_type=deliveroo to a PLATFORM courier order", () => {
    const c = adapter.normalize(liveOrder(), "loc-1")!;
    expect(c.fulfillmentType).toBe("PLATFORM_COURIER");
    expect((c.metadata as any).deliveryType).toBe("PLATFORM");
  });

  it("maps fulfillment_type=customer to PICKUP with no courier gate", () => {
    const c = adapter.normalize(
      liveOrder({ fulfillment_type: "customer" }),
      "loc-1",
    )!;
    expect(c.fulfillmentType).toBe("PICKUP");
    expect((c.metadata as any).deliveryType).toBeUndefined();
  });

  it("maps fulfillment_type=restaurant to merchant DELIVERY", () => {
    const c = adapter.normalize(
      liveOrder({
        fulfillment_type: "restaurant",
        delivery: {
          delivery_fee: { fractional: 79, currency_code: "GBP" },
          customer_name: "John D.",
          location: { latitude: 52.47, longitude: -1.89 },
        },
      }),
      "loc-1",
    )!;
    expect(c.fulfillmentType).toBe("DELIVERY");
    expect((c.metadata as any).deliveryType).toBe("MERCHANT");
    expect(c.deliveryFee).toBe(0.79);
  });

  it("parses the VERIFIED production restaurant-fulfillment shape (flat delivery fields)", () => {
    // Exact shape from a real prod order (webhook_events.rawPayload): the
    // address lives DIRECTLY on delivery (line1/line2/city/postcode), with
    // contact + notes alongside; customer object has no name/contact at all.
    const c = adapter.normalize(
      liveOrder({
        fulfillment_type: "restaurant",
        customer: {
          loyalty: { loyalty_id: "", card_number: "" },
          order_frequency_at_site: "FREQUENT CUSTOMER 5+ ORDERS FROM YOU",
        },
        order_notes: "",
        cutlery_notes: "NO CUTLERY",
        delivery: {
          city: "Newcastle",
          line1: "15 Front Street",
          line2: "",
          location: { latitude: 54.87215, longitude: -1.6142 },
          postcode: "DH21LY",
          deliver_by: "2026-07-02T16:00:52Z",
          delivery_fee: { fractional: 100, currency_code: "GBP" },
          customer_name: "Omid M.",
          contact_number: "442033195035",
          delivery_notes: "",
          contact_access_code: "934770330",
        },
      }),
      "loc-1",
    )!;
    expect(c.deliveryAddress).toMatchObject({
      line1: "15 Front Street",
      city: "Newcastle",
      postcode: "DH21LY",
      coordinates: { lat: 54.87215, lng: -1.6142 },
    });
    expect(c.customerInfo.name).toBe("Omid M.");
    expect(c.customerInfo.phone).toBe("442033195035");
    expect((c.customerInfo as any).phoneAccessCode).toBe("934770330");
    expect(c.deliveryFee).toBe(1);
    expect(c.fulfillmentType).toBe("DELIVERY");
    expect(c.specialInstructions).toBe("NO CUTLERY");
  });

  it("reads phone/code/address off the delivery object (restaurant fulfillment)", () => {
    const c = adapter.normalize(
      liveOrder({
        fulfillment_type: "restaurant",
        customer: { first_name: "Omid" }, // no contact fields on customer
        delivery: {
          contact_number: "442033195035",
          contact_access_code: "087310323",
          delivery_fee: { fractional: 100, currency_code: "GBP" },
          address: {
            line1: "15 Front Street",
            city: "Newcastle",
            post_code: "DH2 1LY",
          },
        },
      }),
      "loc-1",
    )!;
    expect(c.customerInfo.phone).toBe("442033195035");
    expect((c.customerInfo as any).phoneAccessCode).toBe("087310323");
    expect(c.deliveryAddress).toMatchObject({
      line1: "15 Front Street",
      city: "Newcastle",
      postcode: "DH2 1LY",
    });
  });

  it("accepts a plain-string delivery address", () => {
    const c = adapter.normalize(
      liveOrder({
        fulfillment_type: "restaurant",
        delivery: { address: "15 Front Street; Newcastle DH21LY" },
      }),
      "loc-1",
    )!;
    expect(c.deliveryAddress?.line1).toBe("15 Front Street; Newcastle DH21LY");
  });

  it("extracts customer name, masked number and access code", () => {
    const c = adapter.normalize(liveOrder(), "loc-1")!;
    expect(c.customerInfo.name).toBe("Omid");
    expect(c.customerInfo.phone).toBe("+44 20 3699 9999");
    expect((c.customerInfo as any).phoneAccessCode).toBe("1234");
    expect((c.metadata as any).phoneAccessCode).toBe("1234");
  });

  it("marks Deliveroo orders prepaid (CARD/PAID) unless cash is due", () => {
    const prepaid = adapter.normalize(liveOrder(), "loc-1")!;
    expect((prepaid.metadata as any).paymentMethod).toBe("CARD");
    expect((prepaid.metadata as any).paymentStatus).toBe("PAID");

    const cash = adapter.normalize(
      liveOrder({ cash_due: { fractional: 1150, currency_code: "GBP" } }),
      "loc-1",
    )!;
    expect((cash.metadata as any).paymentMethod).toBe("CASH");
    expect((cash.metadata as any).paymentStatus).toBe("PENDING");
  });
});

// ── Outbound sync (Phase BA-4) ─────────────────────────────────────────

function makeSync(orderRow: any) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const client = {
    request: jest.fn((method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      return Promise.resolve({});
    }),
  } as any;
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(orderRow) },
  } as any;
  return { svc: new DeliverooOrderSyncService(prisma, client), calls, client };
}

const directOrder = {
  id: "o1",
  platform: "DELIVEROO",
  integrationSource: "DIRECT",
  viaHubrise: false,
  externalId: "gb:order-1",
  fulfillmentType: "PLATFORM_COURIER",
};

const ev = (toStatus: string, actorType = "STAFF") => ({
  orderId: "o1",
  tenantId: "t1",
  locationId: "l1",
  fromStatus: "PENDING",
  toStatus,
  actorType,
});

describe("DeliverooOrderSyncService", () => {
  it("ACCEPTED → PATCH accepted then sync_status succeeded", async () => {
    const { svc, calls } = makeSync(directOrder);
    await svc.onStatusChanged(ev("ACCEPTED"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /order/v1/orders/gb%3Aorder-1",
      "POST /order/v1/orders/gb%3Aorder-1/sync_status",
    ]);
    expect(calls[0]!.body).toEqual({ status: "accepted" });
    expect(calls[1]!.body).toMatchObject({ status: "succeeded" });
  });

  it("still sends sync_status when the accept PATCH 409s (already accepted)", async () => {
    const { svc, calls, client } = makeSync(directOrder);
    client.request.mockImplementationOnce(() =>
      Promise.reject(new Error("Deliveroo PATCH /order/v1/orders/x → 409: conflict")),
    );
    await svc.onStatusChanged(ev("ACCEPTED"));
    expect(calls.map((c) => c.path)).toEqual([
      "/order/v1/orders/gb%3Aorder-1/sync_status",
    ]);
  });

  it("PREPARING/READY → prep_stage; COMPLETED only for pickup", async () => {
    const { svc, calls } = makeSync({ ...directOrder, fulfillmentType: "PICKUP" });
    await svc.onStatusChanged(ev("PREPARING"));
    await svc.onStatusChanged(ev("READY"));
    await svc.onStatusChanged(ev("COMPLETED"));
    expect(calls.map((c) => c.body.stage)).toEqual([
      "in_kitchen",
      "ready_for_collection",
      "collected",
    ]);
  });

  it("skips COMPLETED for rider-delivered orders (rider webhook owns it)", async () => {
    const { svc, calls } = makeSync(directOrder);
    await svc.onStatusChanged(ev("COMPLETED"));
    expect(calls).toHaveLength(0);
  });

  it("merchant delivery: OUT_FOR_DELIVERY and COMPLETED both send collected (the terminal API stage)", async () => {
    // Verified against the live API: the prep_stage enum ends at "collected"
    // (en_route_to_customer / completed_delivery were rejected with 400
    // "unknown stage"). Deliveroo has no API stage for the delivery movement
    // of restaurant-fulfilled orders.
    const { svc, calls } = makeSync({
      ...directOrder,
      fulfillmentType: "DELIVERY", // fulfillment_type=restaurant → our fleet
    });
    await svc.onStatusChanged(ev("OUT_FOR_DELIVERY"));
    await svc.onStatusChanged(ev("COMPLETED"));
    expect(calls.map((c) => c.body.stage)).toEqual(["collected", "collected"]);
  });

  it("rider orders never push OUT_FOR_DELIVERY (comes inbound from Deliveroo)", async () => {
    const { svc, calls } = makeSync(directOrder); // PLATFORM_COURIER
    await svc.onStatusChanged(ev("OUT_FOR_DELIVERY"));
    expect(calls).toHaveLength(0);
  });

  it("skips inbound webhook-driven transitions (no echo)", async () => {
    const { svc, calls } = makeSync(directOrder);
    await svc.onStatusChanged(ev("ACCEPTED", "WEBHOOK"));
    expect(calls).toHaveLength(0);
  });

  it("skips non-Deliveroo and HubRise-routed orders", async () => {
    const { svc, calls } = makeSync({ ...directOrder, viaHubrise: true });
    await svc.onStatusChanged(ev("ACCEPTED"));
    expect(calls).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Nested modifiers — order #4509, The Grill Stop, 28 Aug 2026.
//
// Deliveroo's own ticket showed "Veggie Burger / On its own / BBQ". Ours
// showed "On its own" alone, and the kitchen sent the burger out without the
// sauce. A Deliveroo modifier is itself an item with its own `modifiers[]`,
// and the adapter only ever read the first level.
// ──────────────────────────────────────────────────────────────────────────

describe("DeliverooAdapter — nested modifiers (#4509)", () => {
  const adapter = new DeliverooAdapter();

  it("keeps a modifier nested under another modifier", () => {
    const c = adapter.normalize(
      liveOrder({
        items: [
          {
            name: "Veggie Burger",
            quantity: 1,
            unit_price: { fractional: 549, currency_code: "GBP" },
            modifiers: [
              {
                name: "On its own",
                quantity: 1,
                unit_price: { fractional: 0, currency_code: "GBP" },
                // The sauce hangs off the option, not off the item.
                modifiers: [
                  {
                    name: "BBQ",
                    quantity: 1,
                    unit_price: { fractional: 0, currency_code: "GBP" },
                  },
                ],
              },
            ],
          },
        ],
      }),
      "loc-1",
    )!;

    expect(c.items[0]!.modifiers!.map((m: any) => m.name)).toEqual([
      "On its own",
      "BBQ",
    ]);
  });

  it("reads the older modifier_groups shape at depth too", () => {
    const c = adapter.normalize(
      liveOrder({
        items: [
          {
            name: "Portuguese",
            quantity: 1,
            unit_price: { fractional: 799, currency_code: "GBP" },
            modifiers: [
              {
                name: "Wrap",
                quantity: 1,
                unit_price: { fractional: 0, currency_code: "GBP" },
                modifier_groups: [
                  { modifiers: [{ name: "Garlic Sauce", quantity: 1 }] },
                ],
              },
            ],
          },
        ],
      }),
      "loc-1",
    )!;

    expect(c.items[0]!.modifiers!.map((m: any) => m.name)).toEqual([
      "Wrap",
      "Garlic Sauce",
    ]);
  });

  it("survives a catalog that nests into itself", () => {
    const loop: any = { name: "Loop", quantity: 1 };
    loop.modifiers = [loop];
    const c = adapter.normalize(
      liveOrder({
        items: [{ name: "Odd", quantity: 1, modifiers: [loop] }],
      }),
      "loc-1",
    )!;
    // Capped, not hung — the point is that it returns at all.
    expect(c.items[0]!.modifiers!.length).toBeLessThanOrEqual(7);
  });

  it("still reads a flat single-level list unchanged", () => {
    const c = adapter.normalize(
      liveOrder({
        items: [
          {
            name: "Chips",
            quantity: 1,
            unit_price: { fractional: 250, currency_code: "GBP" },
            modifiers: [
              { name: "Salt", quantity: 1 },
              { name: "Vinegar", quantity: 1 },
            ],
          },
        ],
      }),
      "loc-1",
    )!;
    expect(c.items[0]!.modifiers!.map((m: any) => m.name)).toEqual([
      "Salt",
      "Vinegar",
    ]);
  });
});
