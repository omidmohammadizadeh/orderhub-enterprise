import { money, summarizeCart, type WaCart } from "../whatsapp-cart";

// Every price the WhatsApp bot and the voice agent say goes through money().
// It was a hardcoded `£${n.toFixed(2)}` in twenty-odd places, so a Dubai
// customer was quoted their order in pounds while the till charged dirhams.

describe("money", () => {
  it.each([
    [3.5, "GBP", "£3.50"],
    [15, "AED", "AED 15.00"],
    [12.5, "SAR", "SAR 12.50"],
  ])("formats %s %s as %s", (n, cur, expected) => {
    expect(money(n as number, cur as string)).toBe(expected);
  });

  it("gives the Gulf dinars their three decimals", () => {
    // 1.250 KWD is one dinar 250 fils. Rounding to two decimals loses real
    // money and prints a price the customer will not be charged.
    expect(money(1.25, "KWD")).toBe("KWD 1.250");
    expect(money(0.5, "BHD")).toBe("BHD 0.500");
    expect(money(2.125, "OMR")).toBe("OMR 2.125");
  });

  it("defaults to sterling, so a caller with no context still renders", () => {
    expect(money(2)).toBe("£2.00");
  });
});

describe("summarizeCart", () => {
  const cart = (over: Partial<WaCart> = {}): WaCart =>
    ({
      fulfillmentType: "DELIVERY",
      items: [
        {
          lineId: "l1",
          itemId: "i1",
          name: "Chicken Shawarma",
          quantity: 2,
          unitBasePrice: 18,
          modifiers: [],
        },
      ],
      ...over,
    }) as WaCart;

  it("prices the whole summary in the shop's currency", () => {
    const out = summarizeCart(cart(), "AED");
    // Lines show the line TOTAL (2 × 18), not the unit price.
    expect(out).toContain("2× Chicken Shawarma — AED 36.00");
    expect(out).toContain("Subtotal: AED 36.00");
    expect(out).not.toContain("£");
  });

  it("puts the area in the address, ahead of city", () => {
    // In the Gulf the community is the part a driver navigates by, and there
    // is no postcode behind it to recover it from if it's dropped.
    const out = summarizeCart(
      cart({
        deliveryAddress: {
          line1: "Marina Gate 2",
          city: "Dubai",
          area: "Dubai Marina",
          country: "AE",
        },
      }),
      "AED",
    );
    expect(out).toContain("Address: Marina Gate 2, Dubai Marina, Dubai");
  });

  it("leaves a UK address reading exactly as it did", () => {
    const out = summarizeCart(
      cart({
        deliveryAddress: {
          line1: "12 High Street",
          city: "Gateshead",
          postcode: "NE10 8YH",
          country: "GB",
        },
      }),
      "GBP",
    );
    expect(out).toContain("Address: 12 High Street, Gateshead, NE10 8YH");
    expect(out).toContain("Subtotal: £36.00");
  });
});
