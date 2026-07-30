import {
  extractSizeKey,
  getModifierPrice,
  getModifierPlu,
  isModifierAvailable,
  calculateCartItem,
  activeModifierGroupIds,
  buildCartItemName,
  round2,
  type PriceableModifier,
  type ProductSku,
} from "@orderhub/shared";

// ──────────────────────────────────────────────────────────────────────────
// Phase AK — Menu pricing helpers
//
// These functions are shared by the API order-validation path and the web
// POS modal. A divergence here = silently mispriced orders, so we lean
// heavy on the test matrix.
// ──────────────────────────────────────────────────────────────────────────

describe("extractSizeKey", () => {
  it.each([
    ["10 inch", "10"],
    ['10"', "10"],
    ["10in", "10"],
    ["10 Inch", "10"],
    ["Pizza 12 inches", "12"],
    ["14", "14"],
    ["Family Size", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("name=%j → %j", (input, expected) => {
    expect(extractSizeKey(input as string | null | undefined)).toBe(expected);
  });
});

describe("getModifierPrice", () => {
  const mod: PriceableModifier = {
    id: "m1",
    name: "Extra cheese",
    priceAdjustment: 0.5,
    pricesBySize: { "10": 0.5, "12": 0.75, "14": 1 },
  };

  it("uses pricesBySize when the size key matches", () => {
    expect(getModifierPrice(mod, "10")).toBe(0.5);
    expect(getModifierPrice(mod, "12")).toBe(0.75);
    expect(getModifierPrice(mod, "14")).toBe(1);
  });

  it("falls back to priceAdjustment when no size key", () => {
    expect(getModifierPrice(mod, null)).toBe(0.5);
  });

  it("falls back to priceAdjustment when size key not in map", () => {
    expect(getModifierPrice(mod, "16")).toBe(0.5);
  });

  it("accepts Prisma Decimal-shaped values", () => {
    const dec = { toNumber: () => 1.25 };
    const m: PriceableModifier = { id: "m", name: "x", priceAdjustment: dec };
    expect(getModifierPrice(m, null)).toBe(1.25);
  });
});

describe("getModifierPlu", () => {
  const mod: PriceableModifier & { plu?: string | null } = {
    id: "m1",
    name: "Extra cheese",
    priceAdjustment: 0.5,
    plu: "TOP-CHEESE",
    skuPlus: { "10": "TOP-CHEESE-10", "12": "TOP-CHEESE-12" },
  };

  it("returns size-specific PLU when size key matches", () => {
    expect(getModifierPlu(mod, "10")).toBe("TOP-CHEESE-10");
  });

  it("falls back to base PLU when no size match", () => {
    expect(getModifierPlu(mod, "20")).toBe("TOP-CHEESE");
  });

  it("returns null when neither matches", () => {
    expect(getModifierPlu({ ...mod, plu: undefined, skuPlus: undefined } as any, null)).toBeNull();
  });
});

describe("isModifierAvailable", () => {
  it("hides modifier when pricesBySize set and size not included", () => {
    const m: PriceableModifier = {
      id: "m1",
      name: "x",
      priceAdjustment: 1,
      pricesBySize: { "10": 0.5, "12": 0.75 },
    };
    expect(isModifierAvailable(m, "10")).toBe(true);
    expect(isModifierAvailable(m, "14")).toBe(false);
  });

  it("shows modifier when pricesBySize empty regardless of size", () => {
    const m: PriceableModifier = {
      id: "m1",
      name: "x",
      priceAdjustment: 1,
    };
    expect(isModifierAvailable(m, "anything")).toBe(true);
    expect(isModifierAvailable(m, null)).toBe(true);
  });

  it("respects isAvailable=false", () => {
    const m: PriceableModifier = {
      id: "m1",
      name: "x",
      priceAdjustment: 1,
      isAvailable: false,
    };
    expect(isModifierAvailable(m, null)).toBe(false);
  });

  it("hides from customer audience when visibleToCustomers=false", () => {
    const m: PriceableModifier = {
      id: "m1",
      name: "x",
      priceAdjustment: 1,
      visibleToCustomers: false,
    };
    expect(isModifierAvailable(m, null, { audience: "customer" })).toBe(false);
    expect(isModifierAvailable(m, null, { audience: "pos" })).toBe(true);
  });
});

describe("calculateCartItem", () => {
  // Regression: the storefront cart summed
  //   (unitPrice + sum(modifiers)) * quantity
  // which charged every option TWICE — a 12" stuffed-crust Toscana rang
  // up at £16.10 instead of £12.00, and the API stores the client's
  // subtotal verbatim, so customers were actually overcharged.
  //
  // The contract this locks: unitPrice is ALREADY modifier-inclusive, so
  // a cart line is unitPrice × quantity and nothing else.
  it("returns a modifier-INCLUSIVE unitPrice — callers must not add modifiers again", () => {
    const line = calculateCartItem({
      basePrice: 7.9, // TOSCANA
      modifiers: [
        { id: "s", name: '12"', groupId: "size", groupName: "Size", price: 1.1 },
        { id: "c", name: "stuffed crust", groupId: "crust", groupName: "Crust", price: 3 },
      ],
      quantity: 1,
    });
    expect(line.unitPrice).toBe(12); // what the modal shows
    expect(line.lineTotal).toBe(12); // what the cart must show

    // The bug, written out so it can never quietly come back.
    const doubleCounted =
      (line.unitPrice + line.modifierTotal) * 1;
    expect(doubleCounted).toBe(16.1);
    expect(line.lineTotal).not.toBe(doubleCounted);
  });

  it("computes unitPrice as basePrice + sum of modifier prices", () => {
    const result = calculateCartItem({
      basePrice: 9.99,
      modifiers: [
        { id: "m1", name: "Cheese", groupId: "g1", groupName: "Toppings", price: 0.5 },
        { id: "m2", name: "Olives", groupId: "g1", groupName: "Toppings", price: 0.75 },
      ],
      quantity: 1,
    });
    expect(result.unitPrice).toBe(11.24);
    expect(result.modifierTotal).toBe(1.25);
    expect(result.lineTotal).toBe(11.24);
  });

  it("multiplies unit price by quantity for line total", () => {
    const result = calculateCartItem({
      basePrice: 9.99,
      modifiers: [
        { id: "m1", name: "Cheese", groupId: "g1", groupName: "Toppings", price: 0.5 },
      ],
      quantity: 3,
    });
    expect(result.unitPrice).toBe(10.49);
    expect(result.lineTotal).toBe(31.47);
  });

  it("treats duplicates as additive (allowDuplicates path)", () => {
    const result = calculateCartItem({
      basePrice: 0,
      modifiers: [
        { id: "m1", name: "Cheese", groupId: "g1", groupName: "Toppings", price: 0.5 },
        { id: "m1", name: "Cheese", groupId: "g1", groupName: "Toppings", price: 0.5 },
        { id: "m1", name: "Cheese", groupId: "g1", groupName: "Toppings", price: 0.5 },
      ],
      quantity: 2,
      allowDuplicates: true,
    });
    expect(result.modifierTotal).toBe(1.5);
    expect(result.lineTotal).toBe(3);
  });

  it("ignores quantity < 1 (treats as 1)", () => {
    const result = calculateCartItem({
      basePrice: 5,
      modifiers: [],
      quantity: 0,
    });
    expect(result.lineTotal).toBe(5);
  });

  it("rounds the classic 1.005 case", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
  });
});

describe("activeModifierGroupIds", () => {
  const product = { modifierGroupIds: ["g_global"] };
  const skus: ProductSku[] = [
    { name: "10 inch", plu: "P10", price: 10, modifierGroups: ["g_crusts", "g_toppings_10"] },
    { name: "12 inch", plu: "P12", price: 12, modifierGroups: ["g_crusts", "g_toppings_12"] },
  ];

  it("returns selected SKU's groups when an SKU is chosen", () => {
    expect(activeModifierGroupIds(product, skus, skus[0]!)).toEqual([
      "g_crusts",
      "g_toppings_10",
    ]);
  });

  it("returns product-level groups when no SKU is chosen", () => {
    expect(activeModifierGroupIds(product, skus, null)).toEqual(["g_global"]);
  });
});

describe("buildCartItemName (KDS parser depends on this format)", () => {
  it("formats with SKU, modifiers, and note", () => {
    expect(
      buildCartItemName({
        productName: "Margherita",
        selectedSku: { name: "10 inch", plu: "PIZZA-10", price: 9.99, modifierGroups: [] },
        modifiers: [{ name: "Classic Crust" }, { name: "Extra Cheese" }],
        note: "no salt",
      }),
    ).toBe("10 inch Margherita (Classic Crust, Extra Cheese) - Note: no salt");
  });

  it("formats without SKU when product is simple", () => {
    expect(
      buildCartItemName({
        productName: "Coke",
        modifiers: [],
      }),
    ).toBe("Coke");
  });

  it("omits parentheses when no modifiers", () => {
    expect(
      buildCartItemName({
        productName: "Margherita",
        selectedSku: { name: "10 inch", plu: "P-10", price: 10, modifierGroups: [] },
        modifiers: [],
      }),
    ).toBe("10 inch Margherita");
  });
});

// ── Service charge ───────────────────────────────────────────────────
import { computeServiceCharge, readServiceCharge } from "../../orders/service-charge";

describe("computeServiceCharge", () => {
  const on = { serviceCharge: { enabled: true, percent: 10, dineInOnly: true } };

  it("adds the percentage to a dine-in bill", () => {
    const r = computeServiceCharge({
      settings: on,
      fulfillmentType: "DINE_IN",
      subtotal: 60,
    });
    expect(r.amount).toBe(6);
  });

  it("charges on the DISCOUNTED subtotal, not the gross", () => {
    // Charging service on money the customer didn't pay would be
    // indefensible if anyone ever checked.
    const r = computeServiceCharge({
      settings: on,
      fulfillmentType: "DINE_IN",
      subtotal: 60,
      discount: 10,
    });
    expect(r.amount).toBe(5);
  });

  it("skips takeaway and delivery when dineInOnly", () => {
    for (const t of ["PICKUP", "DELIVERY", "MERCHANT_DELIVERY"]) {
      expect(
        computeServiceCharge({ settings: on, fulfillmentType: t, subtotal: 60 })
          .amount,
      ).toBe(0);
    }
  });

  it("applies to every channel when dineInOnly is off", () => {
    const r = computeServiceCharge({
      settings: { serviceCharge: { enabled: true, percent: 10, dineInOnly: false } },
      fulfillmentType: "DELIVERY",
      subtotal: 60,
    });
    expect(r.amount).toBe(6);
  });

  it("is zero when disabled or unset", () => {
    expect(
      computeServiceCharge({ settings: {}, fulfillmentType: "DINE_IN", subtotal: 60 })
        .amount,
    ).toBe(0);
    expect(
      computeServiceCharge({
        settings: { serviceCharge: { enabled: false, percent: 10 } },
        fulfillmentType: "DINE_IN",
        subtotal: 60,
      }).amount,
    ).toBe(0);
  });

  it("clamps a fat-fingered percentage at 25%", () => {
    // A typo'd 1000 must not quadruple someone's bill.
    expect(readServiceCharge({ serviceCharge: { enabled: true, percent: 1000 } }).percent).toBe(25);
  });

  it("never charges on a negative base", () => {
    const r = computeServiceCharge({
      settings: on,
      fulfillmentType: "DINE_IN",
      subtotal: 10,
      discount: 25,
    });
    expect(r.amount).toBe(0);
  });
});
