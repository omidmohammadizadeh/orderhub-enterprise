import { describe, expect, it } from "vitest";
import { orderMatchesSearch } from "./order-search";

const order = {
  id: "cmv000000000abc123",
  displayId: "5DF9D",
  orderNumber: 482,
  customerInfo: { name: "José Harikaran", phone: "07788 180709" },
};

describe("orderMatchesSearch", () => {
  it("shows everything for an empty search", () => {
    expect(orderMatchesSearch(order, "   ")).toBe(true);
  });

  it("finds a name in any case, ignoring accents", () => {
    expect(orderMatchesSearch(order, "HARIK")).toBe(true);
    expect(orderMatchesSearch(order, "jose")).toBe(true);
    expect(orderMatchesSearch(order, "Emona")).toBe(false);
  });

  it("finds the order number with or without the #", () => {
    expect(orderMatchesSearch(order, "5df9d")).toBe(true);
    expect(orderMatchesSearch(order, "#5DF9D")).toBe(true);
    expect(orderMatchesSearch(order, "#482")).toBe(true);
  });

  it("finds a phone number however it is typed", () => {
    for (const q of ["07788180709", "0778 818", "7788180709", "+44 7788 180709", "447788180"]) {
      expect(orderMatchesSearch(order, q)).toBe(true);
    }
    const saved = { ...order, customerInfo: { name: "A", phone: "+447788180709" } };
    expect(orderMatchesSearch(saved, "07788180709")).toBe(true);
  });

  it("reads a phone stored flat on the order", () => {
    const flat = { id: "x", customerName: "Sam", customerPhone: "07123456789" };
    expect(orderMatchesSearch(flat, "07123")).toBe(true);
    expect(orderMatchesSearch(flat, "Sam")).toBe(true);
  });

  it("doesn't match on too few digits or a different number", () => {
    expect(orderMatchesSearch(order, "07")).toBe(false);
    expect(orderMatchesSearch(order, "07999999999")).toBe(false);
  });

  it("copes with an order that has no customer", () => {
    expect(orderMatchesSearch({ id: "cmvzzzzzz" }, "smith")).toBe(false);
    expect(orderMatchesSearch({ id: "cmvzzzzzz", customerInfo: null }, "0778")).toBe(false);
  });
});
