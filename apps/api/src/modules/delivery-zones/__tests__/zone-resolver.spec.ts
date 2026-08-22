// The shared zone resolver — @orderhub/shared/lib/delivery-zones.
//
// Tested here rather than in packages/shared because that package has no test
// runner of its own, and this is where the rest of the shared-lib specs live
// (menu-pricing, currency, display-price).
//
// This is the ONE implementation the storefront, the checkout, the POS lookup
// and the WhatsApp bot all match zones with, so what's pinned here is what
// every surface does.

import {
  resolveZone,
  zoneMode,
  areaZoneNames,
  matchAreaZone,
  matchPostcodeZone,
  radiusBands,
  normaliseAreaName,
  postcodeRequiredFor,
  distanceUnitForCountry,
  defaultZoneModeForCountry,
  formatDistance,
  milesToKm,
  kmToMiles,
  type ZoneLike,
} from "@orderhub/shared";

const area = (id: string, areaName: string, fee: number): ZoneLike => ({
  id,
  areaName,
  fee,
});
const postcode = (id: string, postcodePrefix: string, fee: number): ZoneLike => ({
  id,
  postcodePrefix,
  fee,
});
const band = (id: string, maxDistanceMiles: number, fee: number): ZoneLike => ({
  id,
  maxDistanceMiles,
  fee,
});

describe("normaliseAreaName", () => {
  it.each([
    ["Dubai Marina", "dubai marina"],
    ["  DUBAI   MARINA  ", "dubai marina"],
    ["Al Barsha", "barsha"], // the Arabic article is dropped …
    ["Barsha", "barsha"], // … so both spellings are one place
    ["Jumeirah Lake Towers", "jumeirah lake towers"],
    ["Business Bay!", "business bay"],
    ["", ""],
  ])("folds %j → %j", (input, expected) => {
    expect(normaliseAreaName(input)).toBe(expected);
  });

  it("does not fold two genuinely different places together", () => {
    // The normaliser is deliberately not a fuzzy matcher. Charging a Marina
    // fee for a Barsha delivery because the strings looked alike is worse
    // than asking the customer to pick again.
    expect(normaliseAreaName("Dubai Marina")).not.toBe(
      normaliseAreaName("Dubai Media City"),
    );
  });
});

describe("zoneMode", () => {
  it("is NONE for an empty set", () => {
    expect(zoneMode([])).toBe("NONE");
  });

  it("reads the mode off the rows, with area winning a mixed set", () => {
    // The API forbids mixing on write, but old and hand-edited data exists.
    // Precedence has to be defined rather than incidental.
    expect(zoneMode([area("a", "JLT", 12)])).toBe("AREA");
    expect(zoneMode([band("b", 3, 2)])).toBe("RADIUS");
    expect(zoneMode([postcode("p", "SW1", 3)])).toBe("POSTCODE");
    expect(zoneMode([postcode("p", "SW1", 3), area("a", "JLT", 12)])).toBe("AREA");
    expect(zoneMode([postcode("p", "SW1", 3), band("b", 3, 2)])).toBe("RADIUS");
  });

  it("ignores paused rows when deciding the mode", () => {
    // A shop that paused its only area row is not in area mode any more —
    // otherwise every customer would be told the shop doesn't deliver to them.
    expect(
      zoneMode([
        { ...area("a", "JLT", 12), isActive: false },
        postcode("p", "SW1", 3),
      ]),
    ).toBe("POSTCODE");
  });
});

describe("area matching", () => {
  const zones = [area("marina", "Dubai Marina", 15), area("jlt", "JLT", 12)];

  it("matches on the picked name", () => {
    expect(matchAreaZone(zones, "JLT")?.id).toBe("jlt");
  });

  it("matches across the Arabic article and casing", () => {
    const barsha = [area("barsha", "Al Barsha", 18)];
    expect(matchAreaZone(barsha, "barsha")?.id).toBe("barsha");
    expect(matchAreaZone(barsha, "AL BARSHA")?.id).toBe("barsha");
  });

  it("returns null for an area not on the list", () => {
    expect(matchAreaZone(zones, "Al Quoz")).toBeNull();
  });

  it("lists the areas alphabetically for the picker", () => {
    expect(areaZoneNames(zones)).toEqual(["Dubai Marina", "JLT"]);
  });
});

describe("postcode matching", () => {
  it("takes the longest matching prefix", () => {
    const zones = [postcode("broad", "SW1", 3.5), postcode("narrow", "SW1A", 2)];
    expect(matchPostcodeZone(zones, "SW1A 1AA")?.id).toBe("narrow");
    expect(matchPostcodeZone(zones, "SW1X 7XL")?.id).toBe("broad");
  });

  it("skips rows with no prefix instead of throwing on them", () => {
    // The storefront read .toUpperCase() straight off postcodePrefix, so a
    // brand on distance bands white-screened the cart the moment a delivery
    // customer typed an address. Radius and area rows must simply not match.
    const zones = [band("b", 3, 2), area("a", "JLT", 12), postcode("p", "SW1", 3)];
    expect(() => matchPostcodeZone(zones, "SW1A 1AA")).not.toThrow();
    expect(matchPostcodeZone(zones, "SW1A 1AA")?.id).toBe("p");
  });
});

describe("radius bands", () => {
  const zones = [band("far", 5, 6), band("near", 2, 2), band("mid", 3.5, 4)];

  it("fills the lower edge in from the band below, so ranges are contiguous", () => {
    expect(radiusBands(zones).map((b) => [b.from, b.to])).toEqual([
      [0, 2],
      [2, 3.5],
      [3.5, 5],
    ]);
  });

  it("picks the smallest band that still covers the distance", () => {
    expect(resolveZone(zones, { distanceMiles: 1 }).zoneId).toBe("near");
    expect(resolveZone(zones, { distanceMiles: 2 }).zoneId).toBe("near");
    expect(resolveZone(zones, { distanceMiles: 2.1 }).zoneId).toBe("mid");
  });

  it("charges the top band past the furthest edge rather than refusing", () => {
    const out = resolveZone(zones, { distanceMiles: 40 });
    expect(out.zoneId).toBe("far");
    expect(out.beyondLastBand).toBe(true);
  });

  it("charges the top band when the distance is unknown", () => {
    // A failed geocode must not read as "0 miles" and hand out the cheapest
    // band — the safe direction to fail is expensive, not free.
    const out = resolveZone(zones, { distanceMiles: null });
    expect(out.zoneId).toBe("far");
    expect(out.beyondLastBand).toBe(true);
    expect(out.distanceMiles).toBeUndefined();
  });
});

describe("resolveZone in area mode", () => {
  const zones = [area("marina", "Dubai Marina", 15), area("jlt", "JLT", 12)];

  it("prices the picked area", () => {
    const out = resolveZone(zones, { area: "Dubai Marina" });
    expect(out).toMatchObject({
      mode: "AREA",
      matched: true,
      unserviceable: false,
      zoneId: "marina",
      fee: 15,
      label: "Dubai Marina",
    });
  });

  it("marks an unlisted area unserviceable, not merely unmatched", () => {
    // This is the whole area-mode contract: the picker is built from the
    // operator's own rows, so an area that isn't on it is a refusal. The
    // checkout blocks on `unserviceable` and prices around plain `!matched`.
    const out = resolveZone(zones, { area: "Al Quoz" });
    expect(out.matched).toBe(false);
    expect(out.unserviceable).toBe(true);
    expect(out.fee).toBe(0);
  });

  it("treats 'nothing picked yet' as neither matched nor refused", () => {
    const out = resolveZone(zones, { area: "" });
    expect(out.matched).toBe(false);
    expect(out.unserviceable).toBe(false);
  });

  it("cannot be priced by a postcode", () => {
    // A stale or tampered cart may still carry one; it must not select a row.
    const out = resolveZone(zones, { postcode: "SW1A 1AA" });
    expect(out.matched).toBe(false);
    expect(out.mode).toBe("AREA");
  });
});

describe("country conventions", () => {
  it("knows which countries actually use postcodes", () => {
    expect(postcodeRequiredFor("GB")).toBe(true);
    expect(postcodeRequiredFor("IE")).toBe(true);
    // The one that matters: requiring a postcode here left Place order
    // permanently disabled for every Gulf customer.
    expect(postcodeRequiredFor("AE")).toBe(false);
    expect(postcodeRequiredFor("SA")).toBe(false);
    expect(postcodeRequiredFor("KW")).toBe(false);
    expect(postcodeRequiredFor(null)).toBe(true); // defaults to the UK
  });

  it("offers areas by default where there are no postcodes", () => {
    expect(defaultZoneModeForCountry("GB")).toBe("POSTCODE");
    expect(defaultZoneModeForCountry("AE")).toBe("AREA");
  });

  it("reads distance in the unit the country uses", () => {
    expect(distanceUnitForCountry("GB")).toBe("mi");
    expect(distanceUnitForCountry("AE")).toBe("km");
    expect(formatDistance(3, "GB")).toBe("3 mi");
    expect(formatDistance(3, "AE")).toBe("4.8 km");
  });

  it("round-trips a typed distance through the stored miles", () => {
    // Bands are stored in miles whatever the operator types, so a 5 km band
    // has to read back as 5 km and not 4.9 or 5.1.
    expect(Math.round(milesToKm(kmToMiles(5)) * 10) / 10).toBe(5);
  });
});
