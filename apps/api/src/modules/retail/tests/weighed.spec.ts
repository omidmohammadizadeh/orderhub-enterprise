import {
  buildScaleBarcode,
  formatWeight,
  parseScaleBarcode,
  priceForWeight,
  sameScaleCode,
  weighedLineName,
} from "@orderhub/shared";
import { buildPricingContext, priceBasket } from "../../ordering/checkout-pricing";
import { normalizePick, orderedGrams, parseImportSellBy, priceShortfall, stockUnitsFor } from "../retail.logic";

// Weighed products: loose veg and deli, priced per kg / per 100 g, read off
// label-scale barcodes at the till, chosen by amount online and re-weighed at
// picking.

describe("weights and prices", () => {
  it("prices a weight and names the line", () => {
    expect(priceForWeight(1.1, "KG", 642)).toBe(0.71);
    expect(priceForWeight(2.49, "100G", 250)).toBe(6.23);
    expect(formatWeight(642)).toBe("642 g");
    expect(formatWeight(1250)).toBe("1.25 kg");
    expect(formatWeight(2000)).toBe("2 kg");
    expect(weighedLineName("Bananas", 642, 1.1, "KG")).toBe("Bananas — 642 g @ £1.10/kg");
  });
});

describe("scale label barcodes", () => {
  it("reads the price or the weight, per the shop's scale", () => {
    expect(parseScaleBarcode("2100412001232", "PRICE_5")).toEqual({ itemCode: "412", price: 1.23 });
    expect(parseScaleBarcode("2100412001232", "WEIGHT_5")).toEqual({ itemCode: "412", grams: 123 });
    // With a price check digit (the 6 is skipped): 0456 → £4.56.
    expect(parseScaleBarcode("2100412604563", "PRICE_4_CHECK")).toEqual({ itemCode: "412", price: 4.56 });
  });

  it("refuses anything that isn't a valid in-store barcode", () => {
    expect(parseScaleBarcode("2100412001233", "PRICE_5")).toBeNull(); // bad check digit
    expect(parseScaleBarcode("5000112637922", "PRICE_5")).toBeNull(); // a manufacturer barcode
    expect(parseScaleBarcode("2000412000009", "PRICE_5")).toBeNull(); // £0.00
  });

  it("builds test labels the till reads back exactly", () => {
    for (const format of ["PRICE_5", "WEIGHT_5", "PRICE_4_CHECK", "WEIGHT_4_CHECK"] as const) {
      const code = buildScaleBarcode("77", format, { price: 3.74, grams: 150 })!;
      expect(code).toMatch(/^2\d{12}$/);
      expect(parseScaleBarcode(code, format)).toEqual(
        format.startsWith("PRICE") ? { itemCode: "77", price: 3.74 } : { itemCode: "77", grams: 150 },
      );
    }
    expect(buildScaleBarcode("123456", "PRICE_5", { price: 1 })).toBeNull();
    expect(buildScaleBarcode("1", "PRICE_4_CHECK", { price: 120 })).toBeNull();
  });

  it("matches scale codes regardless of leading zeros", () => {
    expect(sameScaleCode("00412", "412")).toBe(true);
    expect(sameScaleCode("412", "4120")).toBe(false);
    expect(sameScaleCode("", "0")).toBe(false);
  });
});

describe("online checkout", () => {
  const ctx = buildPricingContext({
    menu: { categories: [{ items: [{ item: { id: "banana", name: "Bananas", basePrice: 1.1, sellBy: "KG" } }] }] },
  });

  it("prices the chosen amount", () => {
    const r = priceBasket(ctx, [{ menuItemId: "banana", name: "Bananas", quantity: 2, unitPrice: 0.55, weightGrams: 500 }]);
    expect(r.lines[0]!.unitPrice).toBe(0.55);
    expect(r.subtotal).toBe(1.1);
  });

  it("refuses an amount the shop doesn't offer, or a price below it", () => {
    expect(() =>
      priceBasket(ctx, [{ menuItemId: "banana", name: "Bananas", quantity: 1, unitPrice: 0.01, weightGrams: 5000 }]),
    ).toThrow(/price of Bananas has changed/);
    expect(() =>
      priceBasket(ctx, [{ menuItemId: "banana", name: "Bananas", quantity: 1, unitPrice: 1, weightGrams: 437 }]),
    ).toThrow(/choose how much Bananas/);
    expect(() => priceBasket(ctx, [{ menuItemId: "banana", name: "Bananas", quantity: 1, unitPrice: 1.1 }])).toThrow(
      /choose how much/,
    );
  });
});

describe("stock and picking", () => {
  const line = { quantity: 2, metadata: { weight: { grams: 500, sellBy: "KG", pricePerUnit: 1.1, source: "ESTIMATE" } } };

  it("counts weighed stock in grams", () => {
    expect(orderedGrams(line)).toBe(1000);
    expect(stockUnitsFor(line)).toBe(1000);
    expect(stockUnitsFor({ quantity: 3, metadata: {} })).toBe(3);
  });

  it("picks by weight, never substitutes", () => {
    expect(normalizePick({ name: "Bananas", quantity: 2, weightGrams: 1000 }, { picked: 0, grams: 930 })).toEqual({
      picked: 2,
      grams: 930,
      sub: null,
    });
    expect(() =>
      normalizePick(
        { name: "Bananas", quantity: 2, weightGrams: 1000 },
        { picked: 0, grams: 900, sub: { name: "Plantain", qty: 1, unitPrice: 1 } },
      ),
    ).toThrow(/can't be substituted/);
  });

  it("refunds what came in light, nothing extra when heavy, all when none", () => {
    const base = { id: "l1", name: "Bananas", quantity: 2, totalMinor: 110, weightGrams: 1000 };
    expect(priceShortfall({ lines: [{ ...base, pick: { picked: 2, grams: 900 } }], subtotalMinor: 110, discountMinor: 0 }))
      .toMatchObject({ refundMinor: 11, lines: [{ missing: 0, lightGrams: 100 }] });
    expect(
      priceShortfall({ lines: [{ ...base, pick: { picked: 2, grams: 1080 } }], subtotalMinor: 110, discountMinor: 0 }).refundMinor,
    ).toBe(0);
    expect(
      priceShortfall({ lines: [{ ...base, pick: { picked: 0, grams: 0 } }], subtotalMinor: 110, discountMinor: 0 }),
    ).toMatchObject({ refundMinor: 110, lines: [{ missing: 2 }] });
  });

  it("reads a Sold by column", () => {
    expect(["kg", "Per KG", "£/kg", "100g", "per 100 g", "each", ""].map(parseImportSellBy)).toEqual([
      "KG",
      "KG",
      "KG",
      "100G",
      "100G",
      undefined,
      undefined,
    ]);
  });
});
