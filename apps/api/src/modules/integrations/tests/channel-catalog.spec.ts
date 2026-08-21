import {
  channelsForCountry,
  isChannelAvailableIn,
  CHANNELS,
  CHANNEL_COUNTRIES,
} from "@orderhub/shared";

// The country filter on the Brands page is a correctness guard, not a
// convenience: every channel needs credentials and a store id, so offering one
// that can't exist in that country invites a misconfiguration that only shows
// up as a failed order later.

const ids = (country: string) => channelsForCountry(country).map((c) => c.id);

describe("channelsForCountry", () => {
  it("offers the UK marketplaces to a UK brand", () => {
    expect(ids("GB")).toEqual(
      expect.arrayContaining(["JUST_EAT", "UBER_EATS", "DELIVEROO"]),
    );
  });

  it("offers the Gulf marketplaces to a UAE brand", () => {
    expect(ids("AE")).toEqual(expect.arrayContaining(["CAREEM", "TALABAT", "DELIVEROO"]));
  });

  it("never offers Gulf channels in the UK", () => {
    expect(ids("GB")).not.toContain("CAREEM");
    expect(ids("GB")).not.toContain("TALABAT");
  });

  it("never offers UK-only channels in the UAE", () => {
    // Careem absorbed Uber's food business in the region, so Uber Eats is
    // deliberately absent rather than merely unlisted.
    expect(ids("AE")).not.toContain("UBER_EATS");
    expect(ids("AE")).not.toContain("JUST_EAT");
    expect(ids("AE")).not.toContain("STUART");
  });

  it("always offers our own storefront, in every country", () => {
    for (const { code } of CHANNEL_COUNTRIES) {
      expect(ids(code)).toContain("DIRECT_ONLINE");
    }
  });

  it("keeps HubRise out — it is configured per location, not per brand", () => {
    for (const { code } of CHANNEL_COUNTRIES) {
      expect(ids(code)).not.toContain("HUBRISE");
    }
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(ids(" ae ")).toEqual(ids("AE"));
  });

  it("falls back to just our own storefront for an unknown country", () => {
    // Better than showing everything: an unset country must not imply that
    // every marketplace on earth is connectable.
    expect(ids("ZZ")).toEqual(["DIRECT_ONLINE"]);
    expect(channelsForCountry(null).map((c) => c.id)).toEqual(["DIRECT_ONLINE"]);
    expect(channelsForCountry("").map((c) => c.id)).toEqual(["DIRECT_ONLINE"]);
  });
});

describe("isChannelAvailableIn", () => {
  it("agrees with the list it filters", () => {
    expect(isChannelAvailableIn("CAREEM", "AE")).toBe(true);
    expect(isChannelAvailableIn("CAREEM", "GB")).toBe(false);
    expect(isChannelAvailableIn("HUBRISE", "GB")).toBe(false);
  });
});

describe("catalog integrity", () => {
  it("has no duplicate channel ids", () => {
    const seen = CHANNELS.map((c) => c.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("lists every country that some channel names", () => {
    // A channel naming a country the filter can't select is unreachable.
    const known = new Set(CHANNEL_COUNTRIES.map((c) => c.code));
    for (const c of CHANNELS) {
      for (const code of c.countries) {
        expect(known.has(code)).toBe(true);
      }
    }
  });

  it("gives every listed country at least one marketplace", () => {
    // Otherwise the filter offers a country whose only option is our own
    // storefront — which is a channel you get anyway.
    for (const { code } of CHANNEL_COUNTRIES) {
      expect(
        channelsForCountry(code).filter((c) => c.kind !== "direct").length,
      ).toBeGreaterThan(0);
    }
  });
});
