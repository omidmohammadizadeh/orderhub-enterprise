// What the customer's card-machine receipt says.
//
// Dojo defines `amount` as the goods ONLY — "excluding tipsAmount,
// serviceChargeAmount and cashbackAmount" — and itemises from `itemLines`.
// We were sending the order total as `amount` and no lines at all, so a
// receipt printed one number and called the tip food (certification,
// 2026-09-30).
//
// The money taken never changes here; only how it's described. That's exactly
// why it needs pinning: a wrong split still charges the right amount, so
// nothing fails loudly.

import { DojoService } from "../dojo/dojo.service";

const svc = Object.create(DojoService.prototype) as any;
const breakdown = (order: any, amountMinor: number) =>
  svc.receiptBreakdown(order, amountMinor, "GBP");

const item = (name: string, totalPrice: number, modifiers: any[] = []) => ({
  name,
  quantity: 1,
  totalPrice,
  modifiers,
  menuItemId: `plu-${name}`,
});

describe("Dojo receipt breakdown", () => {
  it("takes the tip and service charge out of the goods total", () => {
    // £26.72 bill = £24.29 of food + £2.43 service.
    const out = breakdown(
      { total: 26.72, tipAmount: 0, serviceCharge: 2.43, items: [item("Pizza", 24.29)] },
      2672,
    );
    expect(out.amountMinor).toBe(2429);
    expect(out.serviceChargeMinor).toBe(243);
    expect(out.tipsMinor).toBeUndefined();
  });

  it("passes a tip through as its own line", () => {
    const out = breakdown(
      { total: 12, tipAmount: 2, serviceCharge: 0, items: [item("Burger", 10)] },
      1200,
    );
    expect(out.amountMinor).toBe(1000);
    expect(out.tipsMinor).toBe(200);
  });

  it("folds modifiers into the item name", () => {
    const out = breakdown(
      {
        total: 10.5,
        items: [item("VEGETARIAN", 10.5, [{ name: '10"' }, { name: "deep pan" }])],
      },
      1050,
    );
    expect(out.itemLines?.[0]).toMatchObject({
      name: 'VEGETARIAN (10", deep pan)',
      quantity: 1,
      amountTotal: { value: 1050, currencyCode: "GBP" },
    });
  });

  it("sends no breakdown at all when the lines don't add up", () => {
    // Legacy or hand-edited orders. A receipt whose lines don't sum to the
    // total is worse than a bare amount — the customer can see it's wrong.
    const out = breakdown(
      { total: 20, serviceCharge: 0, items: [item("Burger", 9)] },
      2000,
    );
    expect(out.itemLines).toBeUndefined();
    // The charge itself is untouched.
    expect(out.amountMinor).toBe(2000);
  });

  it("gives up rather than charge a negative amount", () => {
    // A tip larger than the whole charge means our data is wrong somewhere;
    // sending amount: -100 to a card machine is not the way to find out.
    expect(breakdown({ total: 5, tipAmount: 10, items: [] }, 500)).toEqual({});
  });

  it("handles a bill with no tip and no service charge", () => {
    const out = breakdown({ total: 9.99, items: [item("Coke", 9.99)] }, 999);
    expect(out.amountMinor).toBe(999);
    expect(out.tipsMinor).toBeUndefined();
    expect(out.serviceChargeMinor).toBeUndefined();
    expect(out.itemLines).toHaveLength(1);
  });
});
