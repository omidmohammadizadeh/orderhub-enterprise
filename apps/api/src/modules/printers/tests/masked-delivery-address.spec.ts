import { isMaskedValue, describeMaskedAddress } from "@orderhub/shared";

// When Just Eat's own courier delivers, Just Eat masks the customer's details
// and sends asterisks for the name, both address lines, the city and the
// postcode — the shop has no need for them and does not get them.
//
// Printing or displaying those asterisks reads as a broken screen rather than
// a deliberate withholding, which is what a real order on 2 Oct looked like:
//
//   "deliveryAddress": "*************, ***********, ***********, *******"
//
// The coordinates ARE sent, so the map still works; only the text is withheld.

describe("masked values from a delivery partner", () => {
  it("recognises a fully masked field", () => {
    expect(isMaskedValue("***************")).toBe(true);
    expect(isMaskedValue("*******")).toBe(true);
    expect(isMaskedValue("***** ***")).toBe(true);
  });

  it("does not mistake a real address for a masked one", () => {
    expect(isMaskedValue("10 Dundas Street")).toBe(false);
    expect(isMaskedValue("FK3 8BX")).toBe(false);
    // A genuine value that merely contains an asterisk is not masked.
    expect(isMaskedValue("Flat 2*")).toBe(false);
  });

  it("treats blank and missing as not masked — they are simply absent", () => {
    expect(isMaskedValue("")).toBe(false);
    expect(isMaskedValue(null)).toBe(false);
    expect(isMaskedValue(undefined)).toBe(false);
    expect(isMaskedValue("   ")).toBe(false);
  });

  it("explains a wholly masked address instead of repeating the asterisks", () => {
    const said = describeMaskedAddress({
      line1: "*************",
      line2: "***********",
      city: "***********",
      postcode: "*******",
    });
    expect(said).toBeTruthy();
    expect(said).not.toContain("*");
    expect(said).toMatch(/withheld/i);
  });

  it("says nothing for a real address, so normal orders are untouched", () => {
    expect(
      describeMaskedAddress({
        line1: "10 Dundas Street",
        line2: null,
        city: "Grangemouth",
        postcode: "FK3 8BX",
      }),
    ).toBeNull();
  });

  it("says nothing when there is no address at all", () => {
    expect(describeMaskedAddress({})).toBeNull();
    expect(describeMaskedAddress(null)).toBeNull();
  });

  it("explains a partly masked address too — one real line is not enough", () => {
    // Just Eat masks the lot; a half-masked address is still unusable for
    // delivery, so it must not be presented as if it were a real one.
    const said = describeMaskedAddress({
      line1: "*************",
      line2: null,
      city: "Grangemouth",
      postcode: "*******",
    });
    expect(said).toBeTruthy();
    expect(said).not.toContain("*");
  });
});
