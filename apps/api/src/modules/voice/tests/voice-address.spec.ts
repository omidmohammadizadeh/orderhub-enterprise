// Taking a whole address in one breath, the way a taxi line takes a
// destination.
//
// Every case in here is a real response from the geocoder we actually call.
// The two that matter most are the ones where it answers confidently and
// wrongly — a search engine's job is to always return something, and ours is
// to know when it hasn't understood.

import { addressQuery, bestAddress, outwardCode, rankAddresses } from "../voice-address";

const ctx = {
  address: { city: "Washington" },
  deliveryZones: [{ postcodePrefix: "NE37" }],
};

describe("addressQuery", () => {
  it("turns a spoken house number into one a geocoder can use", () => {
    // "eleven Sunningdale Drive" finds nothing; "11 Sunningdale Drive" finds
    // the street.
    expect(addressQuery("Eleven Sunningdale Drive", ctx)).toMatch(/^11 Sunningdale Drive/);
  });

  it("adds the shop's town when the caller didn't name one", () => {
    // Most people don't say the town — they assume you know it. Sunningdale
    // Drive on its own is a street in several counties.
    expect(addressQuery("Eleven Sunningdale Drive", ctx)).toContain("Washington");
  });

  it("does not add a town they already said", () => {
    const q = addressQuery("11 Sunningdale Drive, Washington", ctx);
    expect(q.match(/Washington/g)).toHaveLength(1);
  });
});

describe("outwardCode", () => {
  it("takes the district off a postcode however it is spaced", () => {
    expect(outwardCode("NE37 2LL")).toBe("NE37");
    expect(outwardCode("ne372ll")).toBe("NE37");
  });
});

describe("ranking what came back", () => {
  it("keeps the house number the caller gave, not the geocoder's", () => {
    // OSM rarely knows house numbers on a residential street. The caller
    // always does.
    const out = rankAddresses(
      "Eleven Sunningdale Drive Washington",
      [{ line1: "Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" }],
      ctx,
    );
    expect(bestAddress(out)?.line1).toBe("11 Sunningdale Drive");
    expect(bestAddress(out)?.postcode).toBe("NE37 2LL");
  });

  it("throws out a result for a different road entirely", () => {
    // Asked for "22 Fellside Road Gateshead", Nominatim's top hit was a
    // takeaway on Whitewell Road. Position zero is not an answer.
    const out = rankAddresses(
      "Twenty two Fellside Road Gateshead",
      [{ line1: "22 Whitewell Road", city: "Blaydon on Tyne", postcode: "NE21 5HH" }],
      ctx,
    );
    expect(out).toHaveLength(0);
    expect(bestAddress(out)).toBeNull();
  });

  it("refuses anything without a postcode", () => {
    // Half an address read back sounds exactly like understanding.
    const out = rankAddresses(
      "Eleven Sunningdale Drive",
      [{ line1: "Sunningdale Drive", city: "Washington" }],
      ctx,
    );
    expect(bestAddress(out)).toBeNull();
  });

  it("lets the shop's own delivery zones settle a tie", () => {
    // Two real Fellside Roads came back, one postcode district apart. What
    // decides it is where this shop actually delivers.
    const out = rankAddresses(
      "Twenty two Fellside Road",
      [
        { line1: "Fellside Road", city: "Gateshead", postcode: "NE16 6AB" },
        { line1: "Fellside Road", city: "Washington", postcode: "NE37 5BQ" },
      ],
      ctx,
    );
    expect(bestAddress(out)?.postcode).toBe("NE37 5BQ");
  });

  it("asks rather than guessing when two are equally plausible", () => {
    const out = rankAddresses(
      "Twenty two Fellside Road",
      [
        { line1: "Fellside Road", city: "Gateshead", postcode: "NE16 6AB" },
        { line1: "Fellside Road", city: "Gateshead", postcode: "NE16 5BQ" },
      ],
      { address: { city: "Gateshead" }, deliveryZones: [] },
    );
    expect(out.length).toBe(2);
    expect(bestAddress(out)).toBeNull();
  });

  it("survives the transcript mangling the street", () => {
    const out = rankAddresses(
      "Eleven Sunnyndale Drive Washington",
      [{ line1: "Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" }],
      ctx,
    );
    expect(bestAddress(out)?.line1).toBe("11 Sunningdale Drive");
  });
});
