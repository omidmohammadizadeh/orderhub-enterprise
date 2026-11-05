import { fromGoogleComponents, isValidPoint } from "../providers/reverse-geocode";

const c = (long_name: string, ...types: string[]) => ({ long_name, short_name: long_name, types });

describe("fromGoogleComponents", () => {
  it("names the door, town and postcode", () => {
    const a = fromGoogleComponents(
      [c("14", "street_number"), c("Grey Street", "route"), c("Newcastle upon Tyne", "postal_town"), c("NE1 6AE", "postal_code")],
      54.97,
      -1.61,
    );
    expect(a).toEqual({ line1: "14 Grey Street", city: "Newcastle upon Tyne", postcode: "NE1 6AE", latitude: 54.97, longitude: -1.61 });
  });

  it("keeps a house name in front of the street", () => {
    const a = fromGoogleComponents([c("Rose Cottage", "premise"), c("High Street", "route")], 1, 2);
    expect(a.line1).toBe("Rose Cottage, High Street");
  });

  it("leaves out what Google did not say", () => {
    const a = fromGoogleComponents([c("Dubai Marina", "neighborhood"), c("Dubai", "locality")], 25.08, 55.14);
    expect(a).toEqual({ city: "Dubai", area: "Dubai Marina", latitude: 25.08, longitude: 55.14 });
  });
});

describe("isValidPoint", () => {
  it("refuses junk", () => {
    expect(isValidPoint(NaN, 1)).toBe(false);
    expect(isValidPoint(91, 0)).toBe(false);
    expect(isValidPoint(54.9, -1.5)).toBe(true);
  });
});
