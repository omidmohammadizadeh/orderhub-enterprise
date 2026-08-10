import { canAmendOrderPayment } from "../orders.service";

// Editing a POS order used to require CASH, on the reasoning that a card
// order "may already be captured". True of a PAID card order, but not of an
// unpaid one — and operators kept hitting that: a customer rings back to add
// an item, or decides to pay by card, before any money has moved. This rule
// guards a total that someone has to pay, so it's pinned directly.

describe("canAmendOrderPayment", () => {
  it("allows cash regardless of payment status", () => {
    expect(
      canAmendOrderPayment({ paymentMethod: "CASH", paymentStatus: "PENDING" }),
    ).toBe(true);
    // Preserved deliberately: cash orders were amendable before this change
    // even once marked paid, and narrowing that would break a live workflow.
    expect(
      canAmendOrderPayment({ paymentMethod: "CASH", paymentStatus: "PAID" }),
    ).toBe(true);
  });

  it("allows an unpaid card order — nothing has been captured", () => {
    expect(
      canAmendOrderPayment({ paymentMethod: "CARD_TERMINAL", paymentStatus: "PENDING" }),
    ).toBe(true);
  });

  it("blocks a paid card order", () => {
    expect(
      canAmendOrderPayment({ paymentMethod: "CARD_TERMINAL", paymentStatus: "PAID" }),
    ).toBe(false);
  });

  // AUTHORIZED means money is held on the card but not captured. Amending is
  // still safe: the hold is released or re-taken at the new total.
  it("allows an authorised-but-uncaptured order", () => {
    expect(
      canAmendOrderPayment({ paymentMethod: "CARD", paymentStatus: "AUTHORIZED" }),
    ).toBe(true);
  });

  it("treats a missing payment method as non-cash", () => {
    expect(
      canAmendOrderPayment({ paymentMethod: null, paymentStatus: "PAID" }),
    ).toBe(false);
    expect(
      canAmendOrderPayment({ paymentMethod: undefined, paymentStatus: "PENDING" }),
    ).toBe(true);
  });

  it("is case-insensitive about the method", () => {
    expect(
      canAmendOrderPayment({ paymentMethod: "cash", paymentStatus: "PAID" }),
    ).toBe(true);
  });
});
