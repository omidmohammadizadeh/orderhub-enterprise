import { resolvePosDisplayBrand } from "../orders.service";

describe("resolvePosDisplayBrand", () => {
  it("POS: the location's display brand wins over the menu's brand", () => {
    expect(
      resolvePosDisplayBrand({ source: "POS", requestedBrandId: "burgerz", posBrandId: "pizza-uno" }),
    ).toBe("pizza-uno");
  });

  it("POS with no display brand keeps the menu's brand", () => {
    expect(resolvePosDisplayBrand({ source: "POS", requestedBrandId: "burgerz" })).toBe("burgerz");
  });

  it("VOICE: display brand is only a fallback", () => {
    expect(resolvePosDisplayBrand({ source: "VOICE", requestedBrandId: "b1", posBrandId: "p" })).toBe("b1");
    expect(resolvePosDisplayBrand({ source: "VOICE", posBrandId: "p" })).toBe("p");
  });

  it("online orders keep the brand the customer chose", () => {
    expect(resolvePosDisplayBrand({ source: "ONLINE", requestedBrandId: "monster", posBrandId: "p" })).toBe("monster");
    expect(resolvePosDisplayBrand({ source: "DIRECT", posBrandId: "p" })).toBeUndefined();
  });
});
