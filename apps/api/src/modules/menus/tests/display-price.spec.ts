import { displayPrice, formatDisplayPrice } from "@orderhub/shared";

const sku = (price: number) => ({ price });

describe("displayPrice — a set base price is the headline", () => {
  it("shows the base price, not a cheaper size", () => {
    // THE GRILL STOP's Quarter Chicken: £6.49, with a "Make it meal" size
    // mistyped as £3.99. The card advertised "From £3.99" for a £6.49 item.
    expect(displayPrice({ basePrice: 6.49, productSkus: [sku(6.49), sku(3.99)] })).toEqual({
      amount: 6.49,
      from: false,
    });
  });

  it("says From when a size genuinely costs more", () => {
    expect(displayPrice({ basePrice: 8.5, productSkus: [sku(8.5), sku(10.5)] })).toEqual({
      amount: 8.5,
      from: true,
    });
  });

  it("drops From when every size matches the base", () => {
    expect(displayPrice({ basePrice: 6.49, productSkus: [sku(6.49)] })).toEqual({
      amount: 6.49,
      from: false,
    });
  });
});

describe("displayPrice — no base price falls back to the cheapest size", () => {
  it("quotes the cheapest of several sizes", () => {
    // A sized pizza carries prices only on its sizes; basePrice stays 0.
    expect(displayPrice({ basePrice: 0, productSkus: [sku(12.5), sku(8.5)] })).toEqual({
      amount: 8.5,
      from: true,
    });
  });

  it("does not say From for a single size", () => {
    expect(displayPrice({ basePrice: 0, productSkus: [sku(8.5) ] })).toEqual({
      amount: 8.5,
      from: false,
    });
  });

  it("ignores a half-configured size priced at zero", () => {
    // The bug that made a pizza menu advertise "£0.00".
    expect(displayPrice({ basePrice: 0, productSkus: [sku(0), sku(8.5)] })).toEqual({
      amount: 8.5,
      from: false,
    });
  });
});

describe("displayPrice — products with no sizes", () => {
  it("uses the base price", () => {
    expect(displayPrice({ basePrice: 4.25, productSkus: [] })).toEqual({
      amount: 4.25,
      from: false,
    });
  });

  it("survives a missing or malformed item", () => {
    expect(displayPrice(null)).toEqual({ amount: 0, from: false });
    expect(displayPrice({ basePrice: "6.49" as any, productSkus: undefined })).toEqual({
      amount: 6.49,
      from: false,
    });
  });
});

describe("formatDisplayPrice", () => {
  it("renders the headline base price without a From", () => {
    expect(
      formatDisplayPrice({ basePrice: 6.49, productSkus: [sku(6.49), sku(3.99)] }),
    ).toBe("£6.49");
  });

  it("renders From when sizes go up", () => {
    expect(formatDisplayPrice({ basePrice: 8.5, productSkus: [sku(8.5), sku(10.5)] })).toBe(
      "From £8.50",
    );
  });
});
