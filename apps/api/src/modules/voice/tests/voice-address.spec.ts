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

describe("a shop only ever gets addresses near itself", () => {
  // The failure this exists to prevent, from a live call: the caller gave
  // NE37 2LL and the line read back "Sunningdale Drive, Salford". There is a
  // Sunningdale Drive in Salford, in Belfast, in Bristol and in Washington,
  // and a geocoder asked for one without a town returns whichever is most
  // famous — which is never the one the caller lives on.
  const washington = {
    address: { city: "Washington", postcode: "NE37 1AA" },
    deliveryZones: [{ postcodePrefix: "NE37" }],
  };

  const elsewhere = [
    { line1: "Sunningdale Drive", city: "Salford", postcode: "M27 5AB" },
    { line1: "Sunningdale Drive", city: "Belfast", postcode: "BT14 6SA" },
    { line1: "Sunningdale Drive", city: "Bristol", postcode: "BS30 8GP" },
  ];

  it("throws out the same street in the wrong part of the country", () => {
    const out = rankAddresses("Eleven Sunningdale Drive", elsewhere, washington);
    expect(out).toHaveLength(0);
    expect(bestAddress(out)).toBeNull();
  });

  it("finds the right one when it is in the same list as the wrong ones", () => {
    const out = rankAddresses(
      "Eleven Sunningdale Drive",
      [...elsewhere, { line1: "Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" }],
      washington,
    );
    expect(bestAddress(out)?.postcode).toBe("NE37 2LL");
    expect(bestAddress(out)?.line1).toBe("11 Sunningdale Drive");
  });

  it("still resolves a nearby address the shop does not deliver to", () => {
    // Being outside the delivery area is a thing to TELL somebody, not a
    // reason to pretend we didn't understand them.
    const out = rankAddresses(
      "Eleven Fellside Road",
      [{ line1: "Fellside Road", city: "Gateshead", postcode: "NE16 6AB" }],
      washington,
    );
    expect(bestAddress(out)?.postcode).toBe("NE16 6AB");
  });

  it("runs unfenced when we know nothing about where the shop is", () => {
    const out = rankAddresses("Eleven Sunningdale Drive", [elsewhere[0]!], {
      address: {},
      deliveryZones: [],
    });
    expect(bestAddress(out)?.postcode).toBe("M27 5AB");
  });

  it("lets a postcode the caller gave beat the search engine outright", () => {
    const out = rankAddresses(
      "Eleven Sunningdale Drive",
      [
        { line1: "Sunningdale Drive", city: "Washington", postcode: "NE37 9ZZ" },
        { line1: "Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" },
      ],
      washington,
      "NE37 2LL",
    );
    expect(bestAddress(out)?.postcode).toBe("NE37 2LL");
  });
});

describe("the query always says where in the country to look", () => {
  it("uses the shop's town", () => {
    expect(
      addressQuery("Eleven Sunningdale Drive", {
        address: { city: "Washington", postcode: "NE37 1AA" },
      }),
    ).toBe("11 Sunningdale Drive, Washington");
  });

  it("falls back to the shop's postcode when no town is on file", () => {
    // A shop set up before the structured address columns existed has no city,
    // and an unqualified query is exactly how Salford happened.
    expect(
      addressQuery("Eleven Sunningdale Drive", { address: { postcode: "NE37 1AA" } }),
    ).toBe("11 Sunningdale Drive, NE37 1AA");
  });

  it("prefers a postcode the caller themselves gave", () => {
    // "Sunningdale Drive, NE37" returns Belfast; "Sunningdale Drive, NE37 2LL"
    // returns Washington. A whole postcode is worth having, half of one is not.
    expect(
      addressQuery(
        "Eleven Sunningdale Drive",
        { address: { city: "Washington", postcode: "NE37 1AA" } },
        "NE37 2LL",
      ),
    ).toBe("11 Sunningdale Drive, NE37 2LL");
  });
});
