import * as crypto from "crypto";
import { UberEatsAdapter } from "../adapters/uber-eats.adapter";
import { DeliverooAdapter } from "../adapters/deliveroo.adapter";

const UBER_EATS_FIXTURE = {
  event_type: "orders.notification",
  order: {
    id: "ue-order-123",
    display_id: "#101",
    restaurant_id: "rest-456",
    eater: { first_name: "Alice", last_name: "Smith", phone: "+447700900000" },
    cart: {
      items: [
        {
          title: "Classic Burger",
          quantity: 2,
          base_unit_price: { amount: 1095 },
          price: { amount: 2190 },
          selected_modifier_groups: [
            {
              selected_items: [
                { title: "Extra Cheese", price: { amount: 100 }, quantity: 1 },
              ],
            },
          ],
          special_instructions: "no pickles",
        },
      ],
    },
    delivery_information: {
      type: "DELIVERY",
      location: {
        address: "1 Main St",
        city: "London",
        zip_code: "SW1A 1AA",
      },
    },
    payment: {
      charges: {
        subtotal: { amount: 2190 },
        delivery_fee: { amount: 199 },
        tax: { amount: 44 },
        total: { amount: 2433 },
      },
    },
  },
};

const DELIVEROO_FIXTURE = {
  order: {
    id: "del-order-789",
    display_reference: "#202",
    status: "accepted",
    items: [
      {
        name: "Fish & Chips",
        quantity: 1,
        unit_price_including_tax: { amount: "12.50" },
        total_including_tax: { amount: "12.50" },
        modifier_groups: [],
      },
    ],
    customer: { first_name: "Bob", last_name: "Jones", phone_number: "+447700900001" },
    delivery: {
      type: "delivery",
      address: { address_line_1: "2 High St", postcode: "EC1A 1BB", city: "London" },
    },
    subtotal_including_tax: { amount: "12.50" },
    delivery_charge: { amount: "2.49" },
    total: { amount: "14.99" },
  },
};

function makeHmacSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("UberEatsAdapter", () => {
  let adapter: UberEatsAdapter;

  beforeEach(() => {
    adapter = new UberEatsAdapter();
  });

  describe("verifySignature", () => {
    it("accepts a valid HMAC-SHA256 signature", () => {
      const body = JSON.stringify(UBER_EATS_FIXTURE);
      const secret = "test-secret";
      const sig = makeHmacSignature(body, secret);

      const result = adapter.verifySignature(Buffer.from(body), { "x-uber-signature": sig }, secret);
      expect(result.valid).toBe(true);
    });

    it("rejects a tampered body", () => {
      const body = JSON.stringify(UBER_EATS_FIXTURE);
      const secret = "test-secret";
      const sig = makeHmacSignature(body + "tampered", secret);

      const result = adapter.verifySignature(Buffer.from(body), { "x-uber-signature": sig }, secret);
      expect(result.valid).toBe(false);
    });

    it("rejects missing signature header", () => {
      const body = JSON.stringify(UBER_EATS_FIXTURE);
      const result = adapter.verifySignature(Buffer.from(body), {}, "secret");
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing/i);
    });
  });

  describe("normalize", () => {
    it("produces a valid CanonicalOrder from Uber Eats fixture", () => {
      const canonical = adapter.normalize(UBER_EATS_FIXTURE, "loc-001");
      expect(canonical).not.toBeNull();
      expect(canonical?.platform).toBe("UBER_EATS");
      expect(canonical?.externalId).toBe("ue-order-123");
      expect(canonical?.displayId).toBe("#101");
      expect(canonical?.customerInfo.name).toBe("Alice Smith");
      expect(canonical?.items).toHaveLength(1);
      expect(canonical?.items[0].name).toBe("Classic Burger");
      expect(canonical?.items[0].quantity).toBe(2);
      expect(canonical?.items[0].modifiers).toHaveLength(1);
      expect(canonical?.items[0].modifiers[0].name).toBe("Extra Cheese");
      expect(canonical?.subtotal).toBe(21.9);
      expect(canonical?.deliveryFee).toBe(1.99);
      expect(canonical?.total).toBe(24.33);
      expect(canonical?.fulfillmentType).toBe("PLATFORM_COURIER");
      expect(canonical?.deliveryAddress?.city).toBe("London");
      expect(canonical?.deliveryAddress?.country).toBe("GB");
      expect(canonical?.viaHubrise).toBe(false);
    });

    it("returns null for non-order events", () => {
      const nonOrderEvent = { event_type: "restaurant.opened", restaurant_id: "r1" };
      const result = adapter.normalize(nonOrderEvent, "loc-001");
      expect(result).toBeNull();
    });

    it("returns null if order has no ID", () => {
      const noId = { event_type: "orders.notification", order: { cart: { items: [] } } };
      const result = adapter.normalize(noId, "loc-001");
      expect(result).toBeNull();
    });

    it("sets integrationSource to DIRECT (direct Uber Eats webhook, not via HubRise)", () => {
      const canonical = adapter.normalize(UBER_EATS_FIXTURE, "loc-001");
      expect(canonical?.integrationSource).toBe("DIRECT");
    });
  });
});

describe("DeliverooAdapter", () => {
  let adapter: DeliverooAdapter;

  beforeEach(() => {
    adapter = new DeliverooAdapter();
  });

  describe("verifySignature", () => {
    it("accepts sha256= prefixed signature", () => {
      const body = JSON.stringify(DELIVEROO_FIXTURE);
      const secret = "del-secret";
      const hash = makeHmacSignature(body, secret);
      const sig = `sha256=${hash}`;

      const result = adapter.verifySignature(
        Buffer.from(body),
        { "deliveroo-signature": sig },
        secret,
      );
      expect(result.valid).toBe(true);
    });

    it("rejects missing signature", () => {
      const body = JSON.stringify(DELIVEROO_FIXTURE);
      const result = adapter.verifySignature(Buffer.from(body), {}, "secret");
      expect(result.valid).toBe(false);
    });
  });

  describe("normalize", () => {
    it("produces a valid CanonicalOrder from Deliveroo fixture", () => {
      const canonical = adapter.normalize(DELIVEROO_FIXTURE, "loc-001");
      expect(canonical).not.toBeNull();
      expect(canonical?.platform).toBe("DELIVEROO");
      expect(canonical?.externalId).toBe("del-order-789");
      expect(canonical?.customerInfo.name).toBe("Bob Jones");
      expect(canonical?.total).toBe(14.99);
      expect(canonical?.deliveryAddress?.country).toBe("GB");
    });
  });
});
