import {
  applyMultiBuys,
  basketMinAge,
  parseMultiBuyDeal,
  validateMultiBuy,
  type MultiBuyDeal,
} from "@orderhub/shared";

// The shared multi-buy engine: the till, the storefront and the checkout all
// run this, so these are the numbers a shopper sees everywhere.

const deal = (over: Partial<MultiBuyDeal>): MultiBuyDeal => ({
  id: "d1",
  name: "Deal",
  mode: "FIXED_PRICE",
  quantity: 3,
  price: 2,
  itemIds: [],
  slots: [],
  ...over,
});

describe("applyMultiBuys", () => {
  it("3 for £2 across mixed products, repeated", () => {
    const d = deal({ itemIds: ["crisps", "choc"] });
    const r = applyMultiBuys(
      [
        { menuItemId: "crisps", unitPrice: 1, quantity: 4 },
        { menuItemId: "choc", unitPrice: 0.9, quantity: 3 },
      ],
      [d],
    );
    // 7 units → two deals of 3 (the dearest grouped first): (1+1+1)-2 + (1+0.9+0.9)-2
    expect(r.savings).toBe(1.8);
    expect(r.applied).toEqual([{ dealId: "d1", name: "Deal", times: 2, saving: 1.8 }]);
  });

  it("does nothing below the quantity, or when the deal isn't cheaper", () => {
    const d = deal({ itemIds: ["a"] });
    expect(applyMultiBuys([{ menuItemId: "a", unitPrice: 1, quantity: 2 }], [d]).savings).toBe(0);
    expect(applyMultiBuys([{ menuItemId: "a", unitPrice: 0.5, quantity: 3 }], [d]).savings).toBe(0);
  });

  it("buy 3, cheapest free takes the cheapest of each group", () => {
    const d = deal({ mode: "CHEAPEST_FREE", price: 0, itemIds: ["a", "b", "c"] });
    const r = applyMultiBuys(
      [
        { menuItemId: "a", unitPrice: 5, quantity: 1 },
        { menuItemId: "b", unitPrice: 3, quantity: 1 },
        { menuItemId: "c", unitPrice: 2, quantity: 1 },
      ],
      [d],
    );
    expect(r.savings).toBe(2);
  });

  it("meal deal needs one from every part", () => {
    const d = deal({
      mode: "MEAL_DEAL",
      quantity: 1,
      price: 3.5,
      slots: [
        { name: "Main", itemIds: ["sandwich", "wrap"] },
        { name: "Snack", itemIds: ["crisps"] },
        { name: "Drink", itemIds: ["cola"] },
      ],
    });
    const lines = [
      { menuItemId: "sandwich", unitPrice: 3, quantity: 1 },
      { menuItemId: "wrap", unitPrice: 3.5, quantity: 1 },
      { menuItemId: "crisps", unitPrice: 1, quantity: 2 },
      { menuItemId: "cola", unitPrice: 1.2, quantity: 1 },
    ];
    // One drink → one deal, built on the dearer main: 3.5 + 1 + 1.2 - 3.5
    expect(applyMultiBuys(lines, [d])).toMatchObject({ savings: 2.2, applied: [{ times: 1 }] });
    expect(applyMultiBuys(lines.slice(0, 3), [d]).savings).toBe(0);
  });

  it("a unit counts towards one deal only, the bigger saving first", () => {
    const small = deal({ id: "small", itemIds: ["a"], quantity: 2, price: 1.9 });
    const big = deal({ id: "big", itemIds: ["a"], quantity: 2, price: 1 });
    const r = applyMultiBuys([{ menuItemId: "a", unitPrice: 1, quantity: 2 }], [small, big]);
    expect(r.applied.map((a) => a.dealId)).toEqual(["big"]);
    expect(r.savings).toBe(1);
  });

  it("free lines never count", () => {
    const d = deal({ itemIds: ["a"], quantity: 2, price: 1 });
    expect(
      applyMultiBuys(
        [
          { menuItemId: "a", unitPrice: 1, quantity: 1 },
          { menuItemId: "a", unitPrice: 0, quantity: 1 },
        ],
        [d],
      ).savings,
    ).toBe(0);
  });
});

describe("parseMultiBuyDeal / validateMultiBuy", () => {
  it("reads a campaign row", () => {
    expect(
      parseMultiBuyDeal({ id: "c", name: "3 for £2", itemIds: ["a"], metadata: { multiBuy: { mode: "FIXED_PRICE", quantity: 3, price: 2 } } }),
    ).toMatchObject({ id: "c", mode: "FIXED_PRICE", quantity: 3, price: 2, itemIds: ["a"] });
  });

  it("a half-built row is inert, not an error", () => {
    expect(parseMultiBuyDeal({ id: "c", itemIds: [], metadata: { multiBuy: { mode: "FIXED_PRICE", quantity: 3, price: 2 } } })).toBeNull();
    expect(parseMultiBuyDeal({ id: "c", itemIds: ["a"], metadata: {} })).toBeNull();
  });

  it("explains what's missing", () => {
    expect(validateMultiBuy({ mode: "FIXED_PRICE", quantity: 1, price: 2, itemIds: ["a"], slots: [] })).toMatch(/Quantity/);
    expect(validateMultiBuy({ mode: "MEAL_DEAL", quantity: 1, price: 3, itemIds: [], slots: [{ name: "x", itemIds: ["a"] }] })).toMatch(/two parts/);
    expect(validateMultiBuy({ mode: "CHEAPEST_FREE", quantity: 3, price: 0, itemIds: ["a"], slots: [] })).toBeNull();
  });
});

describe("basketMinAge", () => {
  it("takes the highest restriction and ignores junk", () => {
    expect(basketMinAge([{ minAge: null }, { minAge: 16 }, { minAge: 18 }, undefined])).toBe(18);
    expect(basketMinAge([{ minAge: 21 }, {}])).toBeNull();
  });
});
