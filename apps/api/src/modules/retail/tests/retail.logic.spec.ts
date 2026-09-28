import {
  barcodeLookupKeys,
  isRetailType,
  isValidGtin,
  normalizeBarcode,
  normalizeImportRows,
  parseImportAge,
  parseMoney,
  parseReceiptScan,
  priceReturn,
  receiptCodeFor,
  resolveVariantForLine,
  returnableQuantities,
  type VariantRef,
} from "../retail.logic";

describe("business type", () => {
  it("treats only shops as retail — a restaurant never picks up shop behaviour", () => {
    expect(isRetailType("GROCERY")).toBe(true);
    expect(isRetailType("RETAIL")).toBe(true);
    expect(isRetailType("RESTAURANT")).toBe(false);
    expect(isRetailType(undefined)).toBe(false);
  });
});

describe("barcodes", () => {
  it("cleans what a scanner or a person types", () => {
    expect(normalizeBarcode(" 5 012345 678900 ")).toBe("5012345678900");
    expect(normalizeBarcode("ABC-123")).toBe("ABC-123");
    expect(normalizeBarcode("")).toBeNull();
    expect(normalizeBarcode("<script>")).toBeNull();
  });

  it("refuses a barcode a spreadsheet has already mangled into scientific notation", () => {
    // Excel shows 5012345678900 as 5.01235E+12 — the digits are gone.
    expect(normalizeBarcode("5.01235E+12")).toBeNull();
    expect(normalizeBarcode(5012345678900)).toBe("5012345678900");
  });

  it("checks GS1 check digits", () => {
    expect(isValidGtin("5000112637922")).toBe(true); // EAN-13
    expect(isValidGtin("5000112637923")).toBe(false);
    expect(isValidGtin("036000291452")).toBe(true); // UPC-A
    expect(isValidGtin("96385074")).toBe(true); // EAN-8
    expect(isValidGtin("12345")).toBe(false);
  });

  it("matches a UPC-A with or without the EAN-13 leading zero", () => {
    expect(barcodeLookupKeys("036000291452")).toEqual(["036000291452", "0036000291452"]);
    expect(barcodeLookupKeys("0036000291452")).toEqual(["0036000291452", "036000291452"]);
    expect(barcodeLookupKeys("5000112637922")).toEqual(["5000112637922"]);
  });
});

describe("receipt scans", () => {
  it("round-trips the QR printed on a receipt", () => {
    expect(parseReceiptScan(receiptCodeFor("cmg1abcdef0001"))).toEqual({
      kind: "orderId",
      orderId: "cmg1abcdef0001",
    });
  });

  it("treats anything else as the printed order number", () => {
    expect(parseReceiptScan("#K7Q2M")).toEqual({ kind: "number", value: "K7Q2M" });
    expect(parseReceiptScan("1042")).toEqual({ kind: "number", value: "1042" });
    expect(parseReceiptScan("   ")).toBeNull();
  });

  it("rejects a receipt QR carrying junk instead of an id", () => {
    expect(parseReceiptScan("OHR:'; drop table")).toBeNull();
  });
});

describe("resolveVariantForLine", () => {
  const coke: VariantRef = { id: "v-coke", menuItemId: "coke", sku: "PROD-COKE", trackStock: true };
  const shirtM: VariantRef = { id: "v-m", menuItemId: "shirt", sku: "PROD-SH-1", trackStock: true };
  const shirtL: VariantRef = { id: "v-l", menuItemId: "shirt", sku: "PROD-SH-2", trackStock: true };
  const byItem = new Map([
    ["coke", [coke]],
    ["shirt", [shirtM, shirtL]],
  ]);
  const byId = new Map([coke, shirtM, shirtL].map((v) => [v.id, v]));

  it("trusts the variant the till scanned", () => {
    expect(resolveVariantForLine({ menuItemId: "shirt", metadata: { variantId: "v-l" } }, byItem, byId)).toBe(shirtL);
  });

  it("ignores a scanned variant that belongs to a different product", () => {
    expect(resolveVariantForLine({ menuItemId: "coke", metadata: { variantId: "v-l" } }, byItem, byId)).toBe(coke);
  });

  it("finds the size picked in the size picker by its sku", () => {
    expect(resolveVariantForLine({ menuItemId: "shirt", metadata: { sku: "PROD-SH-1" } }, byItem, byId)).toBe(shirtM);
  });

  it("uses the only variant when there is nothing to choose", () => {
    expect(resolveVariantForLine({ menuItemId: "coke", metadata: {} }, byItem, byId)).toBe(coke);
  });

  it("never guesses between sizes", () => {
    expect(resolveVariantForLine({ menuItemId: "shirt", metadata: {} }, byItem, byId)).toBeNull();
    expect(resolveVariantForLine({ menuItemId: null, metadata: {} }, byItem, byId)).toBeNull();
  });
});

describe("returns", () => {
  const items = [
    { id: "a", name: "Milk", quantity: 2, totalMinor: 230 },
    { id: "b", name: "Bread", quantity: 1, totalMinor: 145 },
  ];

  it("counts down what is left after earlier returns", () => {
    const left = returnableQuantities(items, [{ orderItemId: "a", quantity: 1 }]);
    expect(left.get("a")).toBe(1);
    expect(left.get("b")).toBe(1);
  });

  it("refunds a unit at its share of the line", () => {
    expect(
      priceReturn({ items, prior: [], request: [{ orderItemId: "a", quantity: 1 }], subtotalMinor: 375, discountMinor: 0 }),
    ).toEqual([{ orderItemId: "a", quantity: 1, amountMinor: 115 }]);
  });

  it("scales the refund by an order discount — what was paid, not the shelf price", () => {
    // £10 basket, £2 off → a £1 item refunds 80p.
    const r = priceReturn({
      items: [{ id: "x", name: "Soap", quantity: 10, totalMinor: 1000 }],
      prior: [],
      request: [{ orderItemId: "x", quantity: 1 }],
      subtotalMinor: 1000,
      discountMinor: 200,
    });
    expect(r[0]!.amountMinor).toBe(80);
  });

  it("refuses to return more than was bought, or anything twice", () => {
    const base = { items, subtotalMinor: 375, discountMinor: 0 };
    expect(() => priceReturn({ ...base, prior: [], request: [{ orderItemId: "a", quantity: 3 }] })).toThrow(
      "Only 2 × Milk can still be returned",
    );
    expect(() =>
      priceReturn({ ...base, prior: [{ orderItemId: "b", quantity: 1 }], request: [{ orderItemId: "b", quantity: 1 }] }),
    ).toThrow("Bread has already been returned");
    expect(() =>
      priceReturn({
        ...base,
        prior: [],
        request: [
          { orderItemId: "a", quantity: 1 },
          { orderItemId: "a", quantity: 1 },
        ],
      }),
    ).toThrow("listed twice");
    expect(() => priceReturn({ ...base, prior: [], request: [{ orderItemId: "zzz", quantity: 1 }] })).toThrow(
      "not on this receipt",
    );
    expect(() => priceReturn({ ...base, prior: [], request: [] })).toThrow("at least one");
  });
});

describe("spreadsheet import", () => {
  it("reads an Age column as a Challenge 25 restriction", () => {
    expect([parseImportAge("18"), parseImportAge("18+"), parseImportAge("Yes"), parseImportAge("16")]).toEqual([18, 18, 18, 16]);
    expect([parseImportAge(""), parseImportAge("no"), parseImportAge("21")]).toEqual([undefined, undefined, undefined]);
    const { products } = normalizeImportRows([
      { Name: "Lager 4x440ml", Price: "5.50", "Age restriction": "18+" },
      { Name: "Crisps", Price: "1.00", Age: "" },
    ]);
    expect(products.map((p) => p.minAge)).toEqual([18, undefined]);
  });

  it("reads common header spellings and money formats", () => {
    const { products, errors } = normalizeImportRows([
      { "Product Name": "Coke 330ml", "Selling Price (£)": "£1.25", EAN: "5000112637922", Qty: "24", Department: "Drinks" },
    ]);
    expect(errors).toEqual([]);
    expect(products).toEqual([
      {
        name: "Coke 330ml",
        category: "Drinks",
        description: null,
        variants: [
          {
            row: 1,
            variantName: "Default",
            options: {},
            barcode: "5000112637922",
            sku: null,
            price: 1.25,
            costPrice: null,
            stock: 24,
          },
        ],
      },
    ]);
  });

  it("groups sizes and colours of one product into variants", () => {
    const { products, errors } = normalizeImportRows([
      { name: "Oxford Shirt", price: 30, size: "M", colour: "Blue", barcode: "111" },
      { name: "oxford shirt", price: 30, size: "L", colour: "Blue", barcode: "222" },
    ]);
    expect(errors).toEqual([]);
    expect(products).toHaveLength(1);
    expect(products[0]!.variants.map((v) => v.variantName)).toEqual(["M / Blue", "L / Blue"]);
    expect(products[0]!.variants[1]!.options).toEqual({ size: "L", colour: "Blue" });
  });

  it("reports bad rows and keeps the good ones", () => {
    const { products, errors } = normalizeImportRows([
      { name: "Good", price: "1.00" },
      { name: "No price" },
      { name: "Mangled", price: 1, barcode: "5.01235E+12" },
      { name: "Dupe code A", price: 1, barcode: "999" },
      { name: "Dupe code B", price: 1, barcode: "999" },
      { name: "Good", price: "2.00" },
      {},
    ]);
    expect(products.map((p) => p.name)).toEqual(["Good", "Dupe code A"]);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 5, 6]);
    expect(errors[1]!.message).toMatch(/format the column as Text/);
    expect(errors[3]!.message).toMatch(/add a Size, Colour or Variant column/);
  });

  it("parses money the way shops type it", () => {
    expect(parseMoney("£1,299.50")).toBe(1299.5);
    expect(parseMoney("1,25")).toBe(1.25);
    expect(parseMoney(3)).toBe(3);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("free")).toBeNull();
  });
});
