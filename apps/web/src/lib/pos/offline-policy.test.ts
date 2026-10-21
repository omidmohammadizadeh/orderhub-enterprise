import { describe, expect, it } from "vitest";
import {
  canTakeOffline,
  holdsForPayment,
  isNetworkFailure,
  isRetryableSyncError,
  offlineOrderForPrint,
  offlineRef,
} from "./offline-policy";

describe("canTakeOffline", () => {
  it("allows what can be settled with no connection", () => {
    expect(canTakeOffline("CASH")).toBe(true);
    expect(canTakeOffline("PAY_ON_COLLECTION")).toBe(true);
    // Card on the shop's own machine, confirmed by the operator.
    expect(canTakeOffline("CARD_TERMINAL")).toBe(true);
  });

  it("refuses anything Stripe has to be reachable for", () => {
    for (const m of ["PAYMENT_LINK", "QR_CODE", "ONLINE_CARD", "EXTERNAL", undefined]) {
      expect(canTakeOffline(m)).toBe(false);
    }
  });
});

describe("isNetworkFailure", () => {
  it("is true when the request never got an answer", () => {
    expect(isNetworkFailure({ code: "ERR_NETWORK", message: "Network Error" })).toBe(true);
    expect(isNetworkFailure({ code: "ECONNABORTED", message: "timeout of 20000ms exceeded" })).toBe(true);
  });

  it("is true when the proxy couldn't reach the API", () => {
    for (const status of [502, 503, 504]) {
      expect(isNetworkFailure({ response: { status } })).toBe(true);
    }
  });

  it("is false when the server understood and refused", () => {
    // Queueing a 400 would re-send a payload the server will never accept.
    for (const status of [400, 401, 403, 404, 409, 422, 500]) {
      expect(isNetworkFailure({ response: { status } })).toBe(false);
    }
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe("isRetryableSyncError", () => {
  it("retries what a later pass can fix", () => {
    // 401: the token expired during a long outage. 429: the reconnect burst.
    for (const s of [undefined, 401, 408, 429, 500, 502, 503]) {
      expect(isRetryableSyncError(s)).toBe(true);
    }
  });

  it("parks a payload the server rejected", () => {
    for (const s of [400, 403, 404, 422]) expect(isRetryableSyncError(s)).toBe(false);
  });
});

describe("holdsForPayment", () => {
  it("holds a walk-in cash sale until the keypad settles it", () => {
    expect(holdsForPayment({ paymentMethod: "CASH", paymentStatus: "PENDING", isWalkIn: true })).toBe(true);
    expect(holdsForPayment({ paymentMethod: "CASH", paymentStatus: "PAID", isWalkIn: true })).toBe(false);
  });

  it("holds an offline card sale until the machine says approved", () => {
    expect(holdsForPayment({ paymentMethod: "CARD_TERMINAL", paymentStatus: "PENDING" })).toBe(true);
    expect(holdsForPayment({ paymentMethod: "CARD_TERMINAL", paymentStatus: "PAID" })).toBe(false);
  });

  it("sends phone orders straight to the kitchen", () => {
    expect(holdsForPayment({ paymentMethod: "PAY_ON_COLLECTION", paymentStatus: "PENDING" })).toBe(false);
    // Delivery cash is collected by the driver.
    expect(holdsForPayment({ paymentMethod: "CASH", paymentStatus: "PENDING", isWalkIn: false })).toBe(false);
  });
});

describe("offlineOrderForPrint", () => {
  const body = {
    locationId: "loc-1",
    fulfillmentType: "DELIVERY",
    customerInfo: { name: "Sam", phone: "07700900000" },
    deliveryAddress: { line1: "1 High St", city: "Bristol", postcode: "BS1 4DJ" },
    items: [
      { name: "Margherita", quantity: 2, unitPrice: 9, totalPrice: 18, modifiers: [] },
      { name: "Coke", quantity: 1, unitPrice: 1.5, totalPrice: 1.5, modifiers: [] },
    ],
    subtotal: 19.5,
    deliveryFee: 2.5,
    total: 22,
    paymentMethod: "CASH",
    paymentStatus: "PENDING",
    specialInstructions: "Ring the bell",
  };

  it("carries everything the kitchen and driver need", () => {
    const o = offlineOrderForPrint("local:1234-abcd", body, { queuedAt: 0 });
    expect(o.displayId).toBe(offlineRef("local:1234-abcd"));
    expect(o.displayId).toBe("OFF-ABCD");
    expect(o.items).toHaveLength(2);
    expect(new Set(o.items.map((i: any) => i.id)).size).toBe(2);
    expect(o.postcode).toBe("BS1 4DJ");
    expect(o.customerPhone).toBe("07700900000");
    expect(o.total).toBe(22);
    expect(o.specialInstructions).toContain("OFFLINE ORDER");
    expect(o.specialInstructions).toContain("Ring the bell");
  });
});
